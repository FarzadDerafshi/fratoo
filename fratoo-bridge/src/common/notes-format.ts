// Light formatting for batch notes — the same rules as
// fratoo-web/src/lib/notes.ts (keep the two in step). Deliberately tiny,
// not Markdown: notes are typed on a phone or pasted from a chat, so it
// only recognises what those look like.
//
//   # Heading / ## Heading      → heading
//   - item, * item, • item      → bullet list
//   1. item, 1) item            → numbered list
//   Short line ending in ":"    → bold label ("Good:", "Things to watch:")
//   **bold**                    → bold
//   blank line                  → new paragraph
//
// Everything is HTML-escaped before any tag is added, so the output is safe
// to inject.

/** Notes longer than this get their own card instead of the box under the title. */
export function isLongNote(text: string): boolean {
  return text.length > 280 || text.trim().split('\n').length > 4;
}

export function renderNotesHtml(text: string): string {
  const out: string[] = [];
  // Cast, not an annotation: flushList() reassigns it, which TS doesn't see, so it would narrow to `null`.
  let list = null as { tag: 'ul' | 'ol'; items: string[] } | null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]));
    } else if (line === '') {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(heading[2])}</h4>`);
    } else if (line.endsWith(':') && line.length <= 60) {
      flushPara();
      flushList();
      out.push(`<p class="label"><strong>${inline(line)}</strong></p>`);
    } else {
      flushList();
      para.push(inline(line));
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
