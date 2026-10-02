/** A failed transaction's reason, in the OS error note style, until dismissed. */
export function TxError({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
    if (!message) return null
    return <div className="os-note os-err os-row" role="alert">
        <span className="os-grow">{message}</span>
        <button type="button" className="os-btn os-quiet" onClick={onDismiss}>Dismiss</button>
    </div>
}
