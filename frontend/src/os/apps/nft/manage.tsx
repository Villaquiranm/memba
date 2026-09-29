import { useEffect, useState } from "react"
import { clearGovernanceReceipt, readGovernanceReceipt, type GovernanceScope } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { nftControlRequest, nftControlScope, readNftControlState, NFT_CONTROL_GAS_WANTED,
    type NftControlAction, type NftControlState, type RevokeReason } from "../../../lib/launchpadNftControl"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import type { NativeViewProps } from "../../native/types"
import { useSigner } from "../../sign/signerContext"
import { ErrorState, Loading } from "../../kit"

const reasons: Array<{ value: RevokeReason; label: string }> = [
    { value: "expired", label: "Expired" }, { value: "fraud", label: "Fraud" },
    { value: "eligibility_lost", label: "Eligibility lost" }, { value: "issuer_error", label: "Issuer error" },
    { value: "other", label: "Other" },
]

function PendingTokenAction({ scope, chainId, onClear }: { scope: GovernanceScope; chainId: string; onClear: () => void }) {
    const [checked, setChecked] = useState(false)
    const receipt = readGovernanceReceipt(scope)
    if (!receipt) return null
    const explorer = receipt.hash ? txExplorerUrl(receipt.hash, chainId) : null
    return <div className="os-stack os-note os-warn" role="status">
        <strong>Previous {scope.operation.split(":")[0]} needs chain review</strong>
        <span>Check the transaction and token status before another action.</span>
        {receipt.hash && (explorer ? <a href={explorer} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
        <label className="os-ack"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> I checked the chain and know whether this action succeeded.</label>
        <button type="button" className="os-btn os-quiet" disabled={!checked} onClick={() => {
            try { clearGovernanceReceipt(scope); setChecked(false); onClear() }
            catch { /* in-flight wallet action remains locked */ }
        }}>Review another token action</button>
    </div>
}

export default function ManageLaunchpadToken({ rpcUrl, session, query, available, toast }: {
    rpcUrl: string; session: NativeViewProps["session"]; query?: string; available: boolean; toast: (message: string) => void
}) {
    const signer = useSigner()
    const initialQuery = new URLSearchParams(query ?? "")
    const initialCollection = initialQuery.get("collection") ?? ""
    const initialNumber = initialQuery.get("number") ?? ""
    const [collectionID, setCollectionID] = useState(/^C[1-9]\d*$/.test(initialCollection) ? initialCollection : "")
    const [number, setNumber] = useState(/^[1-9]\d{0,18}$/.test(initialNumber) ? initialNumber : "")
    const [selected, setSelected] = useState<{ collection: string; number: bigint } | null>(null)
    const [revision, setRevision] = useState(0)
    const [state, setState] = useState<NftControlState | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [recipient, setRecipient] = useState("")
    const [reason, setReason] = useState<RevokeReason>("expired")
    const [, redraw] = useState(0)
    const caller = session.status === "member" ? session.address : ""
    useEffect(() => {
        if (!available || !selected) return
        let cancelled = false
        void readNftControlState(rpcUrl, selected.collection, selected.number).then((value) => {
            if (!cancelled) { setState(value); setLoading(false); setError(false) }
        }).catch(() => { if (!cancelled) { setState(null); setLoading(false); setError(true) } })
        return () => { cancelled = true }
    }, [available, rpcUrl, selected, revision])
    const refresh = () => { setLoading(true); setRevision((value) => value + 1) }
    if (!available) return <div className="os-note os-warn" role="note">Token management awaits the reviewed NFT ledger on this network.</div>
    if (session.status !== "member") return <div className="os-stack"><p>Connect a wallet to check and manage an NFT.</p><button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>
    const parsedNumber = /^[1-9]\d{0,18}$/.test(number) && BigInt(number) <= 9223372036854775807n ? BigInt(number) : 0n
    const current = selected?.collection === collectionID && selected.number === parsedNumber ? state : null
    const actions: NftControlAction[] = [{ kind: "transfer", recipient }, { kind: "burn" }, { kind: "revoke", reason }]
    const scopes = current ? actions.map((action) => nftControlScope(session.network.chainId, current, caller, action)) : []
    const pending = scopes.some((scope) => readGovernanceReceipt(scope) !== null)
    const act = (action: NftControlAction) => {
        if (!current) return
        setPreparing(true)
        void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => signer.sign(nftControlRequest({
            state: current, caller, action, rpcUrl, chainId: session.network.chainId,
            estimatedGasFeeUgnot: feeForGasWanted(NFT_CONTROL_GAS_WANTED, gasPrice), onSettled: refresh,
        }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare NFT action."))
            .finally(() => setPreparing(false))
    }
    return <section className="os-stack" aria-label="Manage Launchpad token">
        <div><h1>Manage an NFT</h1><p className="os-sub">Check a token directly on chain. Rights depend on its collection mode and current holder.</p></div>
        <label>Collection ID <input value={collectionID} onChange={(event) => setCollectionID(event.target.value.trim())} placeholder="C1" /></label>
        <label>Token number <input value={number} inputMode="numeric" onChange={(event) => setNumber(event.target.value.trim())} placeholder="1" /></label>
        <button type="button" className="os-btn os-quiet" disabled={!/^C[1-9]\d*$/.test(collectionID) || parsedNumber < 1n || loading} onClick={() => {
            setState(null); setError(false); setLoading(true); setSelected({ collection: collectionID, number: parsedNumber });
            setRevision((value) => value + 1)
        }}>Check token rights</button>
        {loading && <Loading label="Reading token rights…" />}
        {error && <ErrorState message="Could not verify this token from chain." onRetry={refresh} />}
        {current && <div className="os-stack os-note">
            <strong>{current.collection.name} · {current.collection.id} #{current.token.number.toString()}</strong>
            <span>Status: {current.token.status} · {current.collection.mode === "soulbound" ? "Soulbound" : current.collection.mode === "open" ? "Open" : "Royalty protected"}</span>
            {current.token.status === "active" && <span>Holder <code>{current.token.owner}</code></span>}
            <span>Token URI <code style={{ overflowWrap: "anywhere" }}>{current.token.uri}</code></span>
            {current.collection.mode === "soulbound" && <span>Holder burn: allowed · creator revoke: {current.collection.revocable ? "allowed with a public reason" : "not allowed"} · transfer: blocked</span>}
        </div>}
        {current && scopes.map((scope) => <PendingTokenAction key={scope.operation} scope={scope} chainId={session.network.chainId}
            onClear={() => { redraw((value) => value + 1); refresh() }} />)}
        {current && current.token.status === "active" && !pending && <div className="os-stack">
            {current.collection.mode === "open" && current.token.owner === caller && <div className="os-stack os-note">
                <h2>Transfer</h2><p className="os-sub">A direct transfer does not pay creator royalties. Confirm the recipient wallet carefully.</p>
                <label>Recipient wallet <input value={recipient} onChange={(event) => setRecipient(event.target.value.trim())} placeholder="g1…" /></label>
                <button type="button" className="os-btn" disabled={preparing || !recipient} onClick={() => act({ kind: "transfer", recipient })}>Review direct transfer</button>
            </div>}
            {current.token.owner === caller && <div className="os-stack os-note"><h2>Burn</h2>
                <p className="os-sub">Burn permanently retires this token, including a Soulbound credential.</p>
                <button type="button" className="os-btn os-quiet" disabled={preparing} onClick={() => act({ kind: "burn" })}>Review permanent burn</button>
            </div>}
            {current.collection.mode === "soulbound" && current.collection.revocable && current.collection.creator === caller && <div className="os-stack os-note">
                <h2>Revoke Soulbound token</h2><p className="os-sub">The chosen reason is public on chain. Do not include personal information.</p>
                <label>Public revocation reason <select value={reason} onChange={(event) => setReason(event.target.value as RevokeReason)}>
                    {reasons.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select></label>
                <button type="button" className="os-btn os-quiet" disabled={preparing} onClick={() => act({ kind: "revoke", reason })}>Review issuer revocation</button>
            </div>}
        </div>}
    </section>
}
