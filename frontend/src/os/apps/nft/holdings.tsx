import { useEffect, useRef, useState } from "react"
import { fetchLaunchpadHoldings, type LaunchpadHolding } from "../../../lib/launchpadHoldings"
import type { NativeViewProps } from "../../native/types"
import { Card, CardGrid, Empty, ErrorState, Loading, Pill } from "../../kit"
import { specForTarget } from "../../shell/windows"

export default function LaunchpadHoldings({ session, open }: Pick<NativeViewProps, "session" | "open">) {
    const [items, setItems] = useState<LaunchpadHolding[]>([])
    const [cursor, setCursor] = useState("")
    const [nextCursor, setNextCursor] = useState("")
    const [indexedHeight, setIndexedHeight] = useState(0)
    const snapshotHeight = useRef(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")
    const [revision, setRevision] = useState(0)
    const owner = session.status === "member" ? session.address : ""
    const chainId = session.network.chainId

    useEffect(() => {
        if (!owner) return
        const controller = new AbortController()
        void (async () => {
            try {
                const page = await fetchLaunchpadHoldings(owner, chainId, cursor, controller.signal)
                if (controller.signal.aborted) return
                if (cursor && snapshotHeight.current && page.indexedHeight !== snapshotHeight.current) {
                    setError("The index advanced while loading this page. Refresh to see one consistent snapshot.")
                    setNextCursor("")
                    return
                }
                setItems((current) => cursor ? [...current, ...page.items] : page.items)
                setNextCursor(page.nextCursor)
                setIndexedHeight(page.indexedHeight)
                snapshotHeight.current = page.indexedHeight
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load holdings.")
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        })()
        return () => controller.abort()
    }, [owner, chainId, cursor, revision])

    if (!owner) return <div className="os-stack"><h1>Your collectibles</h1><p>Connect a wallet to see collectibles indexed on this network.</p>
        <button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>
    const refresh = () => { setItems([]); setIndexedHeight(0); snapshotHeight.current = 0; setNextCursor(""); setCursor(""); setError(""); setLoading(true); setRevision((value) => value + 1) }
    const loadMore = () => { setError(""); setLoading(true); setCursor(nextCursor) }
    return <section className="os-stack" aria-label="Your Launchpad collectibles">
        <div><h1>Your collectibles</h1><p className="os-sub">Launchpad NFTs owned by this wallet on {chainId}. Each card is an indexed snapshot; token actions check the chain again.</p></div>
        <div className="os-note"><span>Wallet <code style={{ overflowWrap: "anywhere" }}>{owner}</code></span>
            {indexedHeight > 0 && <span className="os-sub os-block">Indexed through block {indexedHeight.toLocaleString()} · confirmed events</span>}</div>
        <div><button type="button" className="os-btn os-quiet" onClick={refresh} disabled={loading}>Refresh holdings</button></div>
        {loading && items.length === 0 && <Loading label="Loading collectibles…" />}
        {error && <ErrorState message={error} onRetry={refresh} />}
        {!loading && !error && items.length === 0 && <Empty title="No Launchpad NFTs found for this wallet." />}
        {items.length > 0 && <CardGrid min={240}>{items.map((item) => <Card key={`${item.collection}:${item.number}`}>
            <span className="os-grow"><b>{item.collection} · #{item.number}</b>
                <span className="os-sub os-block">Last ownership event at block {item.lastEventBlock.toLocaleString()}</span>
                <Pill tone="ok">Held</Pill>
                <span className="os-sub os-block">Current metadata and transfer rights are checked from the NFT realm when you manage this token.</span>
            </span>
            <button type="button" className="os-btn os-quiet" onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "manage",
                query: new URLSearchParams({ collection: item.collection, number: item.number }).toString() })!)}>Manage token</button>
        </Card>)}</CardGrid>}
        {loading && items.length > 0 && <Loading label="Loading more collectibles…" />}
        {!loading && !error && nextCursor && <button type="button" className="os-btn os-quiet" onClick={loadMore}>Load more collectibles</button>}
    </section>
}
