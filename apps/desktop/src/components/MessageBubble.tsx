/**
 * One rendered message row. Phase 1 is plain text; Phase 2 will split out
 * tool-call / tool-result / image / reasoning into their own cards.
 */
import type { MessageRow } from '../state/store.ts'

interface MessageBubbleProps {
  row: MessageRow
}

export function MessageBubble({ row }: MessageBubbleProps): JSX.Element {
  return (
    <div className={`bubble bubble--${row.kind}`}>
      <div className="bubble__kind">{row.kind}</div>
      <div className="bubble__text">{row.text === '' ? <em>(empty)</em> : row.text}</div>
    </div>
  )
}
