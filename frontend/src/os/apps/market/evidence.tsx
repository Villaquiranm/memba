import { useEffect, useRef, useState } from "react"
import { fetchCurationEvidence, type VerifiedCurationEvidence } from "../../../lib/launchpadCurationEvidence"
import { Loading } from "../../kit"

export default function PublicCurationEvidence({ label, cid, sha256, onVerified }: { label: string; cid: string; sha256: string;
    onVerified?: (value: VerifiedCurationEvidence | null) => void }) {
    const [opened, setOpened] = useState(false)
    const [revision, setRevision] = useState(0)
    const [loading, setLoading] = useState(false)
    const [value, setValue] = useState<VerifiedCurationEvidence | null>(null)
    const [error, setError] = useState("")
    const notify = useRef(onVerified)
    useEffect(() => { notify.current = onVerified }, [onVerified])

    useEffect(() => {
        if (!opened) return
        const controller = new AbortController()
        void (async () => {
            try {
                const evidence = await fetchCurationEvidence(cid, sha256, controller.signal)
                if (evidence.cid !== cid || evidence.sha256 !== sha256) throw new Error("Public evidence commitment changed.")
                if (!controller.signal.aborted) { setValue(evidence); setError(""); setLoading(false); notify.current?.(evidence) }
            } catch (cause) {
                if (!controller.signal.aborted) { setValue(null); setError(cause instanceof Error ? cause.message : "Public evidence is unavailable."); setLoading(false); notify.current?.(null) }
            }
        })()
        return () => controller.abort()
    }, [opened, revision, cid, sha256])

    const open = () => { onVerified?.(null); setValue(null); setError(""); setLoading(true); setOpened(true); setRevision((n) => n + 1) }
    const visible = value?.cid === cid && value.sha256 === sha256 ? value : null
    return <div className="os-curation-evidence">
        <div><strong>{label}</strong><button type="button" className="os-btn os-quiet" onClick={open}>{opened ? "Verify again" : "Read verified text"}</button></div>
        <span className="os-sub">IPFS <code>{cid}</code></span>
        <span className="os-sub">SHA-256 <code>{sha256}</code></span>
        {loading && <Loading label={`Verifying ${label.toLowerCase()}…`} />}
        {error && <p role="alert" className="os-note os-warn">{error}</p>}
        {visible && <div className="os-curation-evidence-body"><span role="status">Bytes match the on-chain SHA-256 record</span><pre>{visible.text}</pre></div>}
    </div>
}
