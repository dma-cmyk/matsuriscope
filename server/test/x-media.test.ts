import { describe, expect, it } from 'vitest';
import { extractMediaFromPost } from '../src/adapters/fivech/media.js';
import { xPostEmbed, xPostId, xPostResizeHeight } from '../../web/src/xEmbed.js';

const id = '2021136568967364787';

function extract(url: string) {
  return extractMediaFromPost({ resNo: 7, name: '', dateText: '', rawBodyHtml: url, bodyText: url });
}

const supportedUrls = [
  `https://x.com/Kazy_Suzuki10/status/${id}`,
  `https://www.x.com/Kazy_Suzuki10/status/${id}/`,
  `https://mobile.x.com/Kazy_Suzuki10/status/${id}/photo/2`,
  `https://twitter.com/Kazy_Suzuki10/statuses/${id}/video/1`,
  `https://www.twitter.com/Kazy_Suzuki10/status/${id}?s=20#media`,
  `http://mobile.twitter.com/Kazy_Suzuki10/status/${id}`,
  `https://x.com/i/web/status/${id}`,
  `https://mobile.twitter.com/i/web/status/${id}/`,
];

const unsupportedUrls = [
  `https://x.com.attacker.example/u/status/${id}`,
  `https://notx.com/u/status/${id}`,
  `https://platform.twitter.com/u/status/${id}`,
  `https://twitter.com.attacker.example/u/status/${id}`,
  `https://x.com@attacker.example/u/status/${id}`,
  `https://attacker.example@x.com/u/status/${id}`,
  `https://x.com:444/u/status/${id}`,
  `https://x.com/u/status/${id}junk`,
  `https://x.com/u/status/${id}/evil`,
  `https://x.com/u/status/${id}/photo/0`,
  `https://x.com/u/status/${id}/photo/1/more`,
  `https://x.com/u/status/${id}/video/1evil`,
  `https://x.com/u/status/${id}%2Fphoto%2F1`,
  `https://x.com/u/status/%32${id.slice(1)}`,
  'https://x.com/u/status/0',
  'https://x.com/u/status/0123',
  'https://x.com/u/status/-123',
  'https://x.com/u/status/123.5',
  'https://x.com/u/status/123456789012345678901',
  'https://x.com/u/status/',
  'https://x.com/username_too_long/status/123',
  'https://x.com/user-name/status/123',
  `https://x.com/i/web/status/${id}/extra`,
  `https://x.com/i/web/statuses/${id}`,
  `https://x.com/i/status/${id}/web`,
  `ftp://x.com/u/status/${id}`,
  'javascript:alert(1)',
  '/u/status/123',
  'not a URL',
];

describe('official X post preview URL boundary', () => {
  it.each(supportedUrls)('supports the complete official URL %s without rounding its ID', (url) => {
    expect(xPostId(url)).toBe(id);
    const media = extract(url);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ type: 'twitter', previewable: true, resNo: 7 });
    expect(media[0]!.canonicalUrl).toBe(url.includes('/i/web/')
      ? `https://x.com/i/web/status/${id}`
      : `https://x.com/kazy_suzuki10/status/${id}`);
  });

  it.each(unsupportedUrls)('rejects an unsupported or partial post URL %s', (url) => {
    expect(xPostId(url)).toBeNull();
    expect(xPostEmbed(url)).toBeNull();
    expect(extract(url).some((item) => item.type === 'twitter')).toBe(false);
  });

  it('builds only the official iframe URL and does not reflect source query or fragment parameters', () => {
    const embed = xPostEmbed(`https://x.com/u/status/${id}?id=999&dnt=false&theme=light&origin=https://evil.example#evil`)!;
    const src = new URL(embed.src);
    expect(src.origin).toBe('https://platform.twitter.com');
    expect(src.pathname).toBe('/embed/Tweet.html');
    expect(src.searchParams.get('id')).toBe(id);
    expect(src.searchParams.get('dnt')).toBe('true');
    expect(src.searchParams.has('origin')).toBe(false);
    expect(src.hash).toBe('');
    expect(embed.originalUrl).toBe(`https://x.com/i/web/status/${id}`);
  });

  it('continues to classify original Twitter image and video URLs as direct media', () => {
    expect(extract('https://pbs.twimg.com/media/example?format=jpg&name=large')[0])
      .toMatchObject({ type: 'image', previewable: true });
    expect(extract('https://video.twimg.com/ext_tw_video/123/vid/avc1/example.mp4')[0])
      .toMatchObject({ type: 'video', previewable: true });
    expect(extract('https://example.com/clip.webm')[0])
      .toMatchObject({ type: 'video', previewable: true });
  });
});

describe('official X iframe geometry messages', () => {
  const source = {};
  const embedId = `x-post-${id}`;
  const data = {
    'twttr.embed': {
      jsonrpc: '2.0', method: 'twttr.private.resize', id: embedId,
      params: [{ width: 320, height: 934.2, data: { tweet_id: id } }],
    },
  };
  const event = { origin: 'https://platform.twitter.com', source, data };

  it('uses a matching iframe’s official numeric resize payload to fit the entire post', () => {
    expect(xPostResizeHeight(event, source, embedId)).toBeGreaterThanOrEqual(934.2);
  });

  it.each([
    'https://platform.twitter.com.evil.example', 'http://platform.twitter.com',
    'https://platform.twitter.com:444', 'https://platform.x.com', 'null',
  ])('does not trust an unexpected message origin %s', (origin) => {
    expect(xPostResizeHeight({ ...event, origin }, source, embedId)).toBeNull();
  });

  it('rejects messages from another window, missing frames, or the previous post', () => {
    expect(xPostResizeHeight({ ...event, source: {} }, source, embedId)).toBeNull();
    expect(xPostResizeHeight({ ...event, source: null }, null, embedId)).toBeNull();
    expect(xPostResizeHeight(event, source, 'x-post-another')).toBeNull();
  });

  it.each([null, 'payload', JSON.stringify(data), {}, { 'twttr.embed': null }])('ignores malformed payload %#', (payload) => {
    expect(xPostResizeHeight({ ...event, data: payload }, source, embedId)).toBeNull();
  });

  it.each([0, -1, 99, 10_001, Infinity, NaN, '934', null])('rejects invalid height %s', (height) => {
    const payload = { 'twttr.embed': { ...data['twttr.embed'], params: [{ height }] } };
    expect(xPostResizeHeight({ ...event, data: payload }, source, embedId)).toBeNull();
  });

  it.each(['twttr.private.rendered', 'twttr.private.results', 'twttr.private.no_results', 'twttr.private.trigger'])('does not mistake %s for geometry or media availability', (method) => {
    const payload = { 'twttr.embed': { ...data['twttr.embed'], method } };
    expect(xPostResizeHeight({ ...event, data: payload }, source, embedId)).toBeNull();
  });
});
