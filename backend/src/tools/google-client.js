import { google } from 'googleapis';
import config from '../config.js';
import { decrypt } from '../crypto/tokens.js';
import createMockGoogle from './mock-google.js';

export function makeOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

export function authUrl(state) {
  return makeOAuthClient().generateAuthUrl({
    access_type: 'offline', // required to get a refresh token
    prompt: 'consent',
    scope: config.google.scopes,
    state,
  });
}

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds an RFC-822 message and pins the Message-ID so the send can be found again later. */
export function buildRawMessage({ to, subject, body, rfc822MsgId }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${rfc822MsgId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  return base64url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

/**
 * Returns a Google facade with the same shape as createMockGoogle(), so nothing downstream
 * branches on real-vs-mock. The mock is not a stub of convenience: it implements the same
 * two contracts (Message-ID lookup, client-assigned event id) the reconciliation logic uses.
 */
export async function getGoogleFor(userId, repo, { mock } = {}) {
  if (mock || config.mockGoogle) return getSharedMock();

  const user = await repo.findUserById(userId);
  if (!user?.google_refresh_token_encrypted) {
    const err = new Error('Google account not connected');
    err.code = 'GOOGLE_NOT_CONNECTED';
    throw err;
  }

  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(user.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: 'v1', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  return {
    kind: 'google',
    gmail: {
      async sendMessage({ to, subject, body, rfc822MsgId }) {
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: buildRawMessage({ to, subject, body, rfc822MsgId }) },
        });
        return { id: res.data.id, threadId: res.data.threadId };
      },
      async findByRfc822MsgId(rfc822MsgId) {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `rfc822msgid:${rfc822MsgId}`,
        });
        const hit = res.data.messages?.[0];
        return hit ? { id: hit.id, threadId: hit.threadId } : null;
      },
      async createDraft({ to, subject, body }) {
        const res = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw: buildRawMessage({ to, subject, body, rfc822MsgId: `${Date.now()}@one-work-space` }) } },
        });
        return { id: res.data.id };
      },
    },
    calendar: {
      async insertEvent(event) {
        const res = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            id: event.id,
            summary: event.summary,
            description: event.description,
            start: { dateTime: event.start },
            end: { dateTime: event.end },
            attendees: (event.attendees || []).map((email) => ({ email })),
          },
        });
        return { id: res.data.id, htmlLink: res.data.htmlLink };
      },
      async getEvent(id) {
        try {
          const res = await calendar.events.get({ calendarId: 'primary', eventId: id });
          return { id: res.data.id, htmlLink: res.data.htmlLink };
        } catch (err) {
          if (err.code === 404) return null;
          throw err;
        }
      },
      async listEvents({ timeMin, timeMax }) {
        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 20,
        });
        return (res.data.items || []).map((e) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
        }));
      },
    },
  };
}

let sharedMock;
export function getSharedMock() {
  if (!sharedMock) sharedMock = createMockGoogle();
  return sharedMock;
}
export function resetSharedMock() {
  sharedMock = undefined;
}
