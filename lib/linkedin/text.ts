// Pure: LinkedIn "little text" escaping for the Posts API `commentary` field. No imports (tests).
//
// LinkedIn parses commentary as little text, where | { } @ [ ] ( ) < > # \ * _ ~ are reserved
// (mentions, hashtags, formatting). Unescaped reserved characters can break or truncate a post,
// so each is backslash-escaped, EXCEPT a '#' that starts a hashtag (#word), which is left alone
// so hashtags stay clickable.

const RESERVED = new Set(['|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '\\', '*', '_', '~']);
// A hashtag body character (letters/numbers in any script). '_' is reserved in little text and is
// always escaped, so "#back_pain" posts as the hashtag #back followed by literal "_pain".
const HASHTAG_CHAR = new RegExp('^[\\p{L}\\p{N}]$', 'u');

export function escapeLittleText(text: string): string {
  const chars = Array.from(String(text ?? ''));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '#') {
      const next = chars[i + 1];
      out += next !== undefined && HASHTAG_CHAR.test(next) ? '#' : '\\#';
      continue;
    }
    out += RESERVED.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}
