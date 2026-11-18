import type { RunEvent } from '../../../../shared/api';
import { seconds, usd } from '../../lib/format';
import { precedingText, showResultText } from '../../lib/feed';

function Row({ e, last }: { e: RunEvent; last: string | undefined }) {
  switch (e.kind) {
    case 'text': return <div className="ev">{e.text}</div>;
    case 'tool': return <div className="ev muted mono">{`▸ ${e.name}  ${e.summary}`}</div>;
    case 'tool_result': return e.error ? <div className="ev error mono">{`✗ ${e.text}`}</div> : null;
    case 'reply': return <div className="ev reply"><span className="muted">you · </span>{e.text}</div>;
    case 'resolved': return <div className="ev muted">{`gate: ${e.decision}`}</div>;
    case 'result': return (
      <div className={`ev${e.ok ? '' : ' error'}`}>
        <strong>{e.ok ? 'Done' : 'Failed'}</strong>{e.costUsd != null ? ` · ${usd(e.costUsd)}` : ''}{e.durationMs ? ` · ${seconds(e.durationMs)}` : ''}
        {showResultText(e.text, last) ? <div>{e.text}</div> : null}
      </div>
    );
    case 'stderr': case 'system': return <div className="ev error mono">{e.text}</div>;
    default: return null; // approval / question events are rendered as pending cards
  }
}

export function Feed({ events }: { events: RunEvent[] }) {
  return <div className="feed" aria-live="polite">{events.map((e, i) => <Row key={i} e={e} last={precedingText(events, i)} />)}</div>;
}
