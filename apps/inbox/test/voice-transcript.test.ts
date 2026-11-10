// SCRUM-824 part (a) — a customer's voice note in the thread: its words under
// the audio with a small "transcribed · Thai" label, "Transcribing…" while it
// is pending, and why not when it could not be read, was too long, or no
// provider is configured (data-testid voice-transcript); the hand-over pill a
// note nobody could read makes; and the simulator's audio-file reading. Node,
// no DOM: the bubble is rendered to markup with react-dom/server.
//
// FICTIONAL TEST DATA: every transcript is made-up "ZZ TEST" words.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxEvent, InboxMe, Message } from '@/api/inbox';
import { MessageBubble, VOICE_NOTE_NAME } from '@/components/MessageBubble';
import { voiceContentTypeOf } from '@/components/Simulator';
import {
  VOICE_TRANSCRIPT_TEXT,
  attachmentsOf,
  eventText,
  transcriptLanguageName,
  voiceTranscriptOf,
} from '@/lib/view';

const me: Pick<InboxMe, 'people' | 'teams'> = { teams: [], people: [] };
const NOW = new Date('2026-11-10T08:05:00.000Z');
const AUDIO = '0192f0a0-1234-7abc-8def-00000000a0d1';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm-voice',
    direction: 'inbound',
    authorKind: 'customer',
    authorAccountId: null,
    authorName: null,
    body: null,
    bodyLanguage: null,
    translatedBody: null,
    translatedTo: null,
    mediaFileIds: [],
    audioFileId: AUDIO,
    transcript: null,
    transcriptStatus: 'pending',
    transcriptLanguage: null,
    templateId: null,
    providerStatus: null,
    source: 'channel',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    redacted: false,
    createdAt: '2026-11-10T08:00:00.000Z',
    ...over,
  };
}

const render = (m: Message) =>
  renderToStaticMarkup(createElement(MessageBubble, { m, me, now: NOW, attachments: attachmentsOf(m) }));

/** The voice-transcript block's markup, or null when the bubble has none. */
function block(html: string): string | null {
  const at = html.indexOf('data-testid="voice-transcript"');
  if (at === -1) return null;
  return html.slice(html.lastIndexOf('<div', at), html.indexOf('</div>', at) + 6);
}

describe('the voice note’s words under the audio (voiceTranscriptOf)', () => {
  it('names the language it was heard in: Thai, Russian, English; another code as written', () => {
    expect(transcriptLanguageName('th')).toBe('Thai');
    expect(transcriptLanguageName('ru')).toBe('Russian');
    expect(transcriptLanguageName('en')).toBe('English');
    expect(transcriptLanguageName('uk')).toBe('UK');
    expect(transcriptLanguageName(null)).toBeNull();
  });

  it('reads each state', () => {
    expect(voiceTranscriptOf(msg())).toEqual({ state: 'pending', label: 'Transcribing…' });
    expect(voiceTranscriptOf(msg({ transcriptStatus: 'done', transcript: 'ZZ TEST สวัสดีค่ะ', transcriptLanguage: 'th' }))).toEqual({
      state: 'done',
      label: 'transcribed · Thai',
      text: 'ZZ TEST สวัสดีค่ะ',
    });
    expect(voiceTranscriptOf(msg({ transcriptStatus: 'done', transcript: 'ZZ TEST words', transcriptLanguage: null }))).toMatchObject({
      label: 'transcribed',
    });
    expect(voiceTranscriptOf(msg({ transcriptStatus: 'failed' }))).toEqual({ state: 'failed', label: 'Voice note could not be read' });
    expect(voiceTranscriptOf(msg({ transcriptStatus: 'too_long' }))).toEqual({ state: 'too_long', label: 'Voice note too long to transcribe' });
    expect(voiceTranscriptOf(msg({ transcriptStatus: 'off' }))).toEqual({ state: 'off', label: 'Voice note — not transcribed' });
    // A note from before transcription existed reads as not transcribed.
    expect(voiceTranscriptOf(msg({ transcriptStatus: null }))).toMatchObject({ state: 'off' });
    // A line with no voice note, and an erased one, show nothing.
    expect(voiceTranscriptOf(msg({ audioFileId: null, transcriptStatus: null, body: 'hello' }))).toBeNull();
    expect(voiceTranscriptOf(msg({ redacted: true, transcriptStatus: 'done', transcript: null }))).toBeNull();
  });
});

describe('the audio bubble (MessageBubble)', () => {
  it('done: the transcript under the voice note with "transcribed · Thai"', () => {
    const html = render(msg({ transcriptStatus: 'done', transcript: 'ZZ TEST อยากจัดวันเกิด เด็ก 12 คน', transcriptLanguage: 'th' }));
    const b = block(html)!;
    expect(b).toContain('data-state="done"');
    expect(b).toContain('transcribed · Thai');
    expect(b).toContain('ZZ TEST อยากจัดวันเกิด เด็ก 12 คน');
    // The audio is named and openable; no "No text" beside a voice note.
    expect(html).toContain(`aria-label="Open ${VOICE_NOTE_NAME}"`);
    expect(html).not.toContain('No text');
  });

  it('pending: "Transcribing…"; failed, too long and off: why not', () => {
    expect(block(render(msg()))).toContain(VOICE_TRANSCRIPT_TEXT.pending);
    expect(block(render(msg()))).toContain('data-state="pending"');
    expect(block(render(msg({ transcriptStatus: 'failed' }))) ?? '').toContain('Voice note could not be read');
    expect(block(render(msg({ transcriptStatus: 'too_long' }))) ?? '').toContain('Voice note too long to transcribe');
    expect(block(render(msg({ transcriptStatus: 'off' }))) ?? '').toContain('Voice note — not transcribed');
  });

  it('a voice note the channel never stored still says where its words stand', () => {
    const html = render(msg({ audioFileId: null, transcriptStatus: 'failed' }));
    expect(block(html)).toContain('Voice note could not be read');
    expect(html).not.toContain('No text');
  });

  it('a typed line, a staff line and an erased line carry no transcript block', () => {
    expect(block(render(msg({ audioFileId: null, transcriptStatus: null, body: 'ZZ TEST typed' })))).toBeNull();
    expect(
      block(render(msg({ direction: 'outbound', authorKind: 'staff', authorName: 'ZZ TEST Staff', audioFileId: null, transcriptStatus: null, body: 'hi' }))),
    ).toBeNull();
    expect(block(render(msg({ redacted: true, transcriptStatus: 'done' })))).toBeNull();
  });
});

describe('the hand-over a voice note nobody could read makes', () => {
  const ev = (payload: Record<string, unknown>): InboxEvent => ({
    id: 'e1',
    kind: 'ai_handover',
    actorKind: 'ai',
    actorAccountId: null,
    actorName: null,
    payload,
    createdAt: '2026-11-10T08:01:00.000Z',
  });
  it('says the voice note could not be read, and no intent', () => {
    expect(eventText(ev({ intent: 'other', reason: 'VOICE_UNREAD', reroutedTeamId: null }), { me })).toBe(
      'AI handed over to the team · voice note could not be read',
    );
    // Any other hand-over reads as before.
    expect(eventText(ev({ intent: 'birthday_party', reason: 'OK', reroutedTeamId: null }), { me })).toBe('AI handed over to the team · birthday party');
  });
});

describe('the simulator’s voice-note upload (voiceContentTypeOf)', () => {
  it('takes the browser’s audio type, else the extension; refuses what is no audio', () => {
    expect(voiceContentTypeOf('note.ogg', 'audio/ogg')).toBe('audio/ogg');
    expect(voiceContentTypeOf('PTT-2026.opus', '')).toBe('audio/ogg');
    expect(voiceContentTypeOf('note.m4a', 'video/mp4')).toBe('audio/mp4');
    expect(voiceContentTypeOf('note.MP3', '')).toBe('audio/mpeg');
    expect(voiceContentTypeOf('photo.jpg', 'image/jpeg')).toBeNull();
  });
});
