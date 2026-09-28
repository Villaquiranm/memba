import { useEffect, useState, type FormEvent } from "react"
import type { Token } from "../../../gen/memba/v1/memba_pb"
import { CurationInboxError, readCurationAccess, readCurationThread, sendCurationMessage, type CurationAccess, type CurationMessage } from "../../../lib/launchpadCurationInbox"
import { Loading, Pill } from "../../kit"

const MAX_BYTES = 4000

export default function CurationDiscussion({ collection, account, chainId, token }: {
    collection: string; account: string; chainId: string; token: Token
}) {
    const [access, setAccess] = useState<CurationAccess | null>(null)
    const [messages, setMessages] = useState<CurationMessage[]>([])
    const [cursor, setCursor] = useState("")
    const [loading, setLoading] = useState(true)
    const [olderLoading, setOlderLoading] = useState(false)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState("")
    const [text, setText] = useState("")
    const [clientId, setClientId] = useState("")
    const [revision, setRevision] = useState(0)
    const refresh = () => {
        setAccess(null); setMessages([]); setCursor(""); setError(""); setLoading(true)
        setRevision((value) => value + 1)
    }

    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const permission = await readCurationAccess(collection, account, chainId, token, controller.signal)
                if (!permission.canRead) throw new CurationInboxError(403)
                const page = await readCurationThread(collection, account, chainId, token, "", controller.signal)
                if (controller.signal.aborted) return
                setAccess(permission); setMessages(page.messages); setCursor(page.nextCursor)
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not open this discussion.")
            } finally { if (!controller.signal.aborted) setLoading(false) }
        })()
        return () => controller.abort()
    }, [collection, account, chainId, token, revision])

    const loadOlder = async () => {
        if (!cursor || olderLoading) return
        setOlderLoading(true); setError("")
        try {
            const page = await readCurationThread(collection, account, chainId, token, cursor)
            setMessages((previous) => [...previous, ...page.messages.filter((message) => !previous.some((old) => old.id === message.id))])
            setCursor(page.nextCursor)
        } catch (cause) {
            if (cause instanceof CurationInboxError && (cause.status === 401 || cause.status === 403)) {
                setAccess(null); setMessages([]); setCursor("")
            }
            setError(cause instanceof Error ? cause.message : "Could not load older messages.")
        } finally { setOlderLoading(false) }
    }

    const send = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (sending || !access?.canRead) return
        const content = text.trim()
        if (!content || new TextEncoder().encode(content).length > MAX_BYTES) return
        const id = clientId || Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
        setClientId(id); setSending(true); setError("")
        try {
            await sendCurationMessage(collection, account, chainId, token, id, content)
            setText(""); setClientId(""); refresh()
        } catch (cause) {
            if (cause instanceof CurationInboxError && (cause.status === 401 || cause.status === 403)) {
                setAccess(null); setMessages([]); setCursor("")
            }
            setError(cause instanceof Error ? cause.message : "Could not send the message.")
        } finally { setSending(false) }
    }

    const bytes = new TextEncoder().encode(text.trim()).length
    return <section className="os-curation-discussion" aria-label={`Private discussion for ${collection}`}>
        <div className="os-ops-section-head"><h3>Founder discussion</h3><Pill tone="neutral">Private</Pill></div>
        <p className="os-sub">Only this collection’s founder and currently eligible community managers can read or reply. Public application evidence remains in the record above.</p>
        {loading && <Loading label="Checking your access and loading messages…" />}
        {error && <div className="os-note os-warn" role="alert">{error} <button type="button" className="os-btn os-quiet" onClick={refresh}>Check access again</button></div>}
        {!loading && access && <>
            <div className="os-curation-discussion-context"><span>{access.isFounder ? "Founder" : "Community manager"}</span><span>Application: {access.status.replaceAll("_", " ")}</span><span>Revision {access.revision}</span></div>
            <button type="button" className="os-btn os-quiet os-curation-refresh" onClick={refresh}>Refresh discussion</button>
            {messages.length === 0 ? <p className="os-curation-empty">No messages yet. Start with the collection’s goals, launch timing or the evidence needed for review.</p> :
                <ol className="os-curation-messages" aria-label="Discussion messages">{[...messages].reverse().map((message) =>
                    <li className={message.sender === account ? "os-curation-message mine" : "os-curation-message"} key={message.id}>
                        <div><strong>{message.sender === account ? "You" : message.sender}</strong><time dateTime={new Date(message.createdAt / 1000).toISOString()}>{new Date(message.createdAt / 1000).toLocaleString()}</time></div>
                        <p>{message.text}</p>
                    </li>)}</ol>}
            {cursor && <button type="button" className="os-btn os-quiet" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "Loading…" : "Load older messages"}</button>}
            <form className="os-curation-compose" onSubmit={(event) => void send(event)}>
                <label htmlFor={`curation-message-${collection}`}>Message</label>
                <textarea id={`curation-message-${collection}`} rows={4} value={text} maxLength={4000} onChange={(event) => { setText(event.target.value); setClientId("") }} placeholder="Write to the founder and review team" />
                <div><span className={bytes > MAX_BYTES ? "os-warn" : "os-sub"}>{bytes} / {MAX_BYTES} UTF-8 bytes</span><button className="os-btn" type="submit" disabled={sending || !text.trim() || bytes > MAX_BYTES}>{sending ? "Sending…" : "Send message"}</button></div>
            </form>
        </>}
    </section>
}
