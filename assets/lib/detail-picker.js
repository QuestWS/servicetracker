/**
 * The detail-menu picker: length and beam, then every line on the shop's
 * detail sheet by group, each with a tick, a count and a price the sheet
 * suggests and a person can overwrite. Used by the Detail Tracker (a new
 * request, editing one) and by the writer's portal (Detail on a work order),
 * so the two can never offer different menus.
 *
 * Browser only. The prices come from detail-menu.js, which is under test.
 */
import { DETAIL_MENU, DETAIL_GROUPS, suggestPrice, ftIn } from './detail-menu.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function splitFt(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return ['', ''];
  let ft = Math.floor(n);
  let inch = Math.round((n - ft) * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return [String(ft), inch ? String(inch) : ''];
}

/**
 * `el` gets the picker. `opts.items` is what is on the detail already (lines
 * with an id keep it, so their ticks and answers survive an edit); lines the
 * menu does not know (a winter line) are shown fixed above the menu.
 */
export function mountPicker(el, opts = {}) {
  const have = {};
  const fixed = [];
  (opts.items || []).forEach((x) => {
    if (x.key && DETAIL_MENU.some((m) => m.key === x.key) && !have[x.key] && !x.winter) have[x.key] = x;
    else fixed.push(x);
  });
  const [lf, li] = splitFt(opts.loa);
  const [bf, bi] = splitFt(opts.beam);
  const open = new Set(Object.values(have).map((x) => (DETAIL_MENU.find((m) => m.key === x.key) || {}).group));
  if (!open.size) open.add(DETAIL_GROUPS[0]);

  el.innerHTML = `
    <div class="dp-dims">
      <div><label class="fld">Length overall</label>
        <div class="dp-ftin"><input class="txt" data-d="lf" inputmode="decimal" value="${esc(lf)}" placeholder="ft"><span>ft</span>
        <input class="txt" data-d="li" inputmode="numeric" value="${esc(li)}" placeholder="in"><span>in</span></div></div>
      <div><label class="fld">Beam</label>
        <div class="dp-ftin"><input class="txt" data-d="bf" inputmode="decimal" value="${esc(bf)}" placeholder="ft"><span>ft</span>
        <input class="txt" data-d="bi" inputmode="numeric" value="${esc(bi)}" placeholder="in"><span>in</span></div></div>
    </div>
    <p class="hint">Length includes platform and pulpit. Over 8&prime;6&Prime; beam takes the wide price. Prices are the
      detail sheet&rsquo;s starting figures &mdash; change any of them.</p>
    ${fixed.length ? `<div class="dp-fixed">${fixed.map((x) => `<div class="dp-line on fixed"><span class="dp-name">${esc(x.label)}</span>
      <span class="dp-amt">${x.price == null ? 'no price yet' : '$' + Number(x.price).toFixed(2)}</span></div>`).join('')}
      <p class="hint">From the winter quote &mdash; priced and answered there.</p></div>` : ''}
    ${DETAIL_GROUPS.map((g) => `<details class="dp-group" ${open.has(g) ? 'open' : ''}><summary>${esc(g)}</summary>
      ${DETAIL_MENU.filter((m) => m.group === g).map((m) => {
        const x = have[m.key];
        return `<div class="dp-line${x ? ' on' : ''}" data-key="${esc(m.key)}" data-id="${esc(x ? x.id : '')}">
          <label class="dp-tick"><input type="checkbox" ${x ? 'checked' : ''}><span class="dp-name">${esc(m.label)}</span></label>
          ${m.key === 'other' ? `<input class="txt dp-words" placeholder="What is it?" value="${esc(x && x.label !== m.label ? x.label : '')}">` : ''}
          <div class="dp-nums">
            <label>&times;<input class="txt dp-qty" inputmode="numeric" value="${esc(x ? x.qty : 1)}"></label>
            <label>$<input class="txt dp-price" inputmode="decimal" value="${esc(x && x.price != null ? x.price : '')}"></label>
          </div>
          <div class="dp-how"></div>
          ${m.about ? `<div class="dp-about">${esc(m.about)}</div>` : ''}
        </div>`;
      }).join('')}</details>`).join('')}`;

  const dims = () => {
    const v = (k) => el.querySelector(`[data-d="${k}"]`).value;
    return { loa: ftIn(v('lf'), v('li')), beam: ftIn(v('bf'), v('bi')) };
  };

  /* A price somebody typed is theirs. Only an empty box, or one still holding
     the last suggestion, follows the sheet when the dimensions change. */
  function refresh() {
    const d = dims();
    el.querySelectorAll('.dp-line[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const qty = row.querySelector('.dp-qty').value;
      const s = suggestPrice(key, { loa: d.loa, beam: d.beam, qty });
      const price = row.querySelector('.dp-price');
      const auto = price.value === '' || price.dataset.auto === price.value;
      if (auto && s.amount != null) { price.value = s.amount.toFixed(2); price.dataset.auto = price.value; }
      if (auto && s.amount == null && price.dataset.auto) { price.value = ''; price.dataset.auto = ''; }
      row.querySelector('.dp-how').textContent = s.amount != null ? s.how : s.why;
      row.dataset.how = s.amount != null ? s.how : '';
    });
    if (opts.onChange) opts.onChange();
  }

  el.addEventListener('input', (ev) => {
    if (ev.target.classList.contains('dp-price')) ev.target.dataset.auto = '';
    if (ev.target.matches('.dp-words, .dp-qty, .dp-price') && !ev.target.closest('.dp-line').querySelector('input[type=checkbox]').checked) {
      if (!ev.target.classList.contains('dp-qty')) {
        ev.target.closest('.dp-line').querySelector('input[type=checkbox]').checked = true;
        ev.target.closest('.dp-line').classList.add('on');
      }
    }
    refresh();
  });
  el.addEventListener('change', (ev) => {
    if (ev.target.type === 'checkbox') ev.target.closest('.dp-line').classList.toggle('on', ev.target.checked);
    if (opts.onChange) opts.onChange();
  });
  refresh();

  return {
    dims,
    /** The lines ticked, ready for the backend; fixed (winter) lines ride along untouched. */
    items() {
      const out = fixed.map((x) => Object.assign({}, x));
      el.querySelectorAll('.dp-line[data-key]').forEach((row) => {
        if (!row.querySelector('input[type=checkbox]').checked) return;
        const m = DETAIL_MENU.find((x) => x.key === row.dataset.key);
        const words = row.querySelector('.dp-words');
        const p = row.querySelector('.dp-price').value.replace(/[$,\s]/g, '');
        out.push({
          id: row.dataset.id || '', key: m.key, group: m.group,
          label: m.key === 'other' && words && words.value.trim() ? words.value.trim() : m.label,
          qty: Number(row.querySelector('.dp-qty').value) || 1,
          price: p === '' || !isFinite(Number(p)) ? null : Number(p),
          how: row.dataset.how || '',
        });
      });
      return out;
    },
  };
}

/** The picker's own styles, injected once so each page that mounts it needs no CSS of its own. */
export const PICKER_CSS = `
.dp-dims{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dp-ftin{display:flex;align-items:center;gap:6px}
.dp-ftin input{width:70px;padding:10px}
.dp-ftin span{color:var(--muted);font-size:13px}
.dp-group{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:#fff}
.dp-group>summary{cursor:pointer;padding:11px 13px;font-weight:700;color:var(--navy);list-style-position:inside}
.dp-line{border-top:1px solid var(--ice);padding:9px 13px;display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center}
.dp-line.on{background:#f6fbf7}
.dp-line.fixed{border:1px solid var(--line);border-radius:8px;margin:6px 0;display:flex;justify-content:space-between}
.dp-tick{display:flex;gap:9px;align-items:center;cursor:pointer;font-weight:600}
.dp-tick input{width:20px;height:20px;flex:none}
.dp-nums{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}
.dp-nums label{display:flex;align-items:center;gap:3px}
.dp-qty{width:46px;padding:7px}
.dp-price{width:92px;padding:7px;font-family:var(--mono)}
.dp-words{grid-column:1/-1;padding:8px}
.dp-how,.dp-about{grid-column:1/-1;font-size:12.5px;color:var(--muted)}
.dp-about{font-style:italic}
.dp-amt{font-family:var(--mono)}
@media(max-width:420px){.dp-line{grid-template-columns:1fr}.dp-dims{grid-template-columns:1fr}}
`;
