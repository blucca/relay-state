const byId = id => document.getElementById(id);
const connection = byId('connection');
let snapshot;
let highlight;

function render(value) {
  const changed = snapshot && (snapshot.id !== value.id || snapshot.revision !== value.revision);
  snapshot = value;
  byId('loading').hidden = true;
  byId('desk').hidden = false;
  byId('order').textContent = `Return · ${value.order}`;
  byId('item-name').textContent = value.item;
  byId('merchant').textContent = `${value.merchant} · expected refund`;
  byId('amount').textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: value.refund.currency }).format(value.refund.cents / 100);
  byId('stage').textContent = value.status;
  byId('stage').classList.toggle('complete', value.complete);
  byId('next-title').textContent = value.nextAction.title;
  byId('next-description').textContent = value.nextAction.instruction;
  byId('next-command').textContent = value.nextAction.command;
  byId('copy-command').textContent = 'Copy';
  byId('progress').textContent = `${value.progress.completed} / ${value.progress.total} reported`;
  byId('task-id').textContent = value.id;
  byId('revision').textContent = `revision ${value.revision}`;
  byId('timeline').replaceChildren(...value.timeline.map(step => {
    const row = document.createElement('li');
    row.className = step.report ? 'done' : step.current ? 'current' : 'upcoming';
    const title = document.createElement('strong');
    title.textContent = step.title;
    row.append(title);
    if (step.report) {
      const detail = document.createElement('p');
      detail.textContent = `${step.report.reference} · user report`;
      const time = document.createElement('time');
      time.dateTime = step.report.at;
      time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(step.report.at));
      row.append(detail, time);
    }
    return row;
  }));
  if (changed) {
    const panel = document.querySelector('.next-action');
    clearTimeout(highlight);
    panel.classList.add('changed');
    highlight = setTimeout(() => panel.classList.remove('changed'), 900);
  }
}

byId('copy-command').addEventListener('click', async () => {
  if (!snapshot) return;
  try {
    await navigator.clipboard.writeText(snapshot.nextAction.command);
    byId('copy-command').textContent = 'Copied';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(byId('next-command'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    byId('copy-command').textContent = 'Selected';
  }
});

const events = new EventSource('/events');
events.onopen = () => {
  connection.classList.add('live');
  connection.textContent = 'Live · saved return connected';
};
events.onmessage = event => {
  const { value } = JSON.parse(event.data);
  render(value);
};
events.onerror = () => {
  connection.classList.remove('live');
  connection.textContent = snapshot ? 'Reconnecting · saved view retained' : 'Connecting to local server…';
};
window.addEventListener('pagehide', () => events.close(), { once: true });
