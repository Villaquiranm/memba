/** Native Market desk for Launchpad records and the existing service lane. */
import { useEffect, useState } from "react"
import type { NativeViewProps } from "../../native/types"
import { GNO_RPC_URL, NETWORKS, isNftEnabled, isRealmValidOn } from "../../../lib/config"
import { LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "../../../lib/nftConfig"
import { LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_CURATION_PATH } from "../../../lib/nftConfig"
import { getLaunchpadMarketQuote, getLaunchpadOfferQuote, listLaunchpadMarketListings, listLaunchpadMarketOffers, type LaunchpadMarketListing, type LaunchpadMarketOffer, type LaunchpadMarketQuote, type LaunchpadOfferQuote } from "../../../lib/launchpadMarket"
import { Empty, ErrorState, Loading, Pill } from "../../kit"
import { specForTarget } from "../../shell/windows"
import MarketOperations from "./operations"
import "./native.css"

const PAGE_SIZE = 20

export default function MarketWindow({ section, session, open, fallback }: NativeViewProps) {
    if (section !== null && section !== "launchpad" && section !== "operations") return <>{fallback}</>

    const network = session.network.key
    const rpcUrl = NETWORKS[network]?.rpcUrl ?? GNO_RPC_URL
    const available = isNftEnabled() && isRealmValidOn(network, LAUNCHPAD_NFT_PATH) && isRealmValidOn(network, LAUNCHPAD_MARKET_PATH)
    const curationAvailable = isNftEnabled() && isRealmValidOn(network, LAUNCHPAD_NFT_PATH) && isRealmValidOn(network, LAUNCHPAD_CURATION_PATH)
    const openServices = () => open(specForTarget({ kind: "app", app: "market", section: "services" })!)
    const openLaunchpad = () => open(specForTarget({ kind: "app", app: "market", section: "launchpad" })!)
    const openOperations = () => open(specForTarget({ kind: "app", app: "market", section: "operations" })!)

    if (section === "operations") {
        return curationAvailable
            ? <MarketOperations key={network} rpcUrl={rpcUrl} daoAvailable={isRealmValidOn(network, LAUNCHPAD_CURATION_DAO_PATH)} />
            : <div className="os-stack"><div className="os-note os-warn" role="note">Market Operations is awaiting the governed curation realm on this network.</div><button type="button" className="os-btn os-quiet" onClick={openServices}>Open services</button></div>
    }

    if (section === "launchpad") {
        return available
            ? <LaunchpadMarket key={network} rpcUrl={rpcUrl} openServices={openServices} />
            : <div className="os-stack"><div className="os-note os-warn" role="note">Launchpad NFT trading is not available on this network. Its settlement realm must be published and allowlisted before listings can appear.</div><button type="button" className="os-btn os-quiet" onClick={openServices}>Open services</button></div>
    }

    return <div className="os-market-home">
        <header className="os-market-intro">
            <div className="os-market-title"><span className="os-market-mark" aria-hidden="true">◇</span><h1>Trade with the full story</h1></div>
            <p>Find work and collect on Gno. See where each asset comes from and what a transaction means before you act.</p>
        </header>
        <div className="os-market-lanes">
            <button type="button" className="os-market-lane" onClick={openServices}>
                <span className="os-market-lane-name">Services <span aria-hidden="true">↗</span></span>
                <span>Hire and work with escrow through the service market.</span>
                <span className="os-market-lane-action">Open services</span>
            </button>
            <div className="os-market-lane os-market-lane-nft">
                <span className="os-market-lane-name">Collectibles</span>
                <span>Explore Launchpad NFT sale records with seller, royalty and DAO terms from chain.</span>
                {available
                    ? <button type="button" className="os-btn" onClick={openLaunchpad}>Explore NFT records</button>
                    : <Pill tone="neutral">Awaiting Launchpad publication</Pill>}
            </div>
            <div className="os-market-lane os-market-lane-ops">
                <span className="os-market-lane-name">Market Operations</span>
                <span>See the DAO appointed review team, founder applications and public curation decisions.</span>
                {curationAvailable
                    ? <button type="button" className="os-btn" onClick={openOperations}>Open operations</button>
                    : <Pill tone="neutral">Awaiting DAO handoff</Pill>}
            </div>
        </div>
        <p className="os-sub os-market-footnote">Launchpad listings appear only after this network enables the NFT ledger and market realm. Existing NFT trading remains in its current Market lane.</p>
    </div>
}

function LaunchpadMarket({ rpcUrl, openServices }: { rpcUrl: string; openServices: () => void }) {
    const [tab, setTab] = useState<"listings" | "offers">("listings")
    return <div className="os-stack os-market-records">
        <header className="os-market-records-head">
            <div><h1>Collectibles</h1><p className="os-sub">Listings and funded offers from the Launchpad market realm. Prices are raw currency units; quotes come from chain.</p></div>
            <button type="button" className="os-btn os-quiet" onClick={openServices}>Services</button>
        </header>
        <div className="os-note" role="note">This view is read only while trading and wallet review are being completed. Ownership, approval and policy are checked again before settlement.</div>
        <div className="os-market-tabs" role="tablist" aria-label="Collectible market records">
            <button type="button" role="tab" aria-selected={tab === "listings"} onClick={() => setTab("listings")}>Listings</button>
            <button type="button" role="tab" aria-selected={tab === "offers"} onClick={() => setTab("offers")}>Offers</button>
        </div>
        {tab === "listings" ? <LaunchpadListings rpcUrl={rpcUrl} /> : <LaunchpadOffers rpcUrl={rpcUrl} />}
    </div>
}

function LaunchpadListings({ rpcUrl }: { rpcUrl: string }) {
    const [items, setItems] = useState<LaunchpadMarketListing[]>([])
    const [page, setPage] = useState(0)
    const [revision, setRevision] = useState(0)
    const [settled, setSettled] = useState({ page: -1, revision: -1, error: false })
    const [hasMore, setHasMore] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    const [quote, setQuote] = useState<{ id: string; value?: LaunchpadMarketQuote; error?: boolean } | null>(null)
    const loading = settled.page !== page || settled.revision !== revision
    const error = !loading && settled.error

    useEffect(() => {
        let cancelled = false
        void listLaunchpadMarketListings(rpcUrl, page, PAGE_SIZE).then((next) => {
            if (cancelled) return
            setItems((previous) => page === 0 ? next : [...previous, ...next])
            setHasMore(next.length === PAGE_SIZE)
            setSettled({ page, revision, error: false })
        }).catch(() => {
            if (cancelled) return
            setSettled({ page, revision, error: true })
        })
        return () => { cancelled = true }
    }, [rpcUrl, page, revision])

    useEffect(() => {
        if (!selected) return
        const item = items.find((listing) => listing.id === selected)
        if (!item) return
        let cancelled = false
        void getLaunchpadMarketQuote(rpcUrl, item).then((value) => {
            if (!cancelled) setQuote({ id: selected, value })
        }).catch(() => {
            if (!cancelled) setQuote({ id: selected, error: true })
        })
        return () => { cancelled = true }
    }, [rpcUrl, selected, items])

    const retry = () => setRevision((value) => value + 1)
    return <div className="os-stack">
        {loading && items.length === 0 && <Loading label="Loading Launchpad sale records…" />}
        {error && <ErrorState message="Could not read sale records from this network." onRetry={retry} />}
        {!loading && !error && items.length === 0 && <Empty title="No Launchpad sale records have been created yet." />}
        {items.length > 0 && <div className="os-market-list" role="list">{items.map((item) => <article className="os-market-record" role="listitem" key={item.id}>
            <div className="os-market-record-core">
                <span className="os-market-token">{item.collection} <span aria-hidden="true">/</span> #{item.number.toString()}</span>
                <strong>{item.price.toLocaleString()} <small>{currencyLabel(item.currency)}</small></strong>
            </div>
            <div className="os-market-record-meta"><Pill tone={item.status === "active" ? "ok" : "neutral"}>{item.status}</Pill><span>DAO {formatBPS(item.protocolFeeBPS)} · Creator {formatBPS(item.royaltyBPS)}</span><span>Seller {item.seller.slice(0, 10)}{item.seller.length > 10 ? "…" : ""}</span></div>
            <button type="button" className="os-btn os-quiet" aria-expanded={selected === item.id} onClick={() => { setSelected((id) => id === item.id ? null : item.id); setQuote(null) }}>{selected === item.id ? "Hide terms" : "Inspect terms"}</button>
            {selected === item.id && <div className="os-market-terms">
                <span>Seller <code>{item.seller}</code></span>
                <span>Currency <code>{item.currency}</code></span>
                <span>Listing {item.id} · Fee fixed at config version {item.configVersion.toString()}</span>
                {!quote || quote.id !== item.id || (!quote.value && !quote.error) ? <Loading label="Reading sale split…" /> : quote.error ? <span role="alert">Could not verify the current sale split.</span> : <>
                    <span>Seller receives {quote.value!.sellerAmount.toLocaleString()} · DAO receives {quote.value!.protocolAmount.toLocaleString()} · Creator royalties {quote.value!.royaltyTotal.toLocaleString()}</span>
                    <span>DAO treasury <code>{quote.value!.treasury}</code></span>
                    {quote.value!.royalties.map((receiver) => <span key={receiver.account}>Royalty {receiver.amount.toLocaleString()} to <code>{receiver.account}</code></span>)}
                    <span>{quote.value!.executable ? "Token and approval currently match the listing." : "Listing is not executable now."} Trading policy is checked again when buying.</span>
                </>}
            </div>}
        </article>)}</div>}
        {loading && items.length > 0 && <Loading label="Loading more sale records…" />}
        {!error && !loading && hasMore && <button type="button" className="os-btn os-quiet" onClick={() => setPage((value) => value + 1)}>Load more records</button>}
    </div>
}

function LaunchpadOffers({ rpcUrl }: { rpcUrl: string }) {
    const [items, setItems] = useState<LaunchpadMarketOffer[]>([])
    const [page, setPage] = useState(0)
    const [revision, setRevision] = useState(0)
    const [settled, setSettled] = useState({ page: -1, revision: -1, error: false })
    const [hasMore, setHasMore] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    const [quote, setQuote] = useState<{ id: string; value?: LaunchpadOfferQuote; error?: boolean } | null>(null)
    const loading = settled.page !== page || settled.revision !== revision
    const error = !loading && settled.error

    useEffect(() => {
        let cancelled = false
        void listLaunchpadMarketOffers(rpcUrl, page, PAGE_SIZE).then((next) => {
            if (cancelled) return
            setItems((previous) => page === 0 ? next : [...previous, ...next])
            setHasMore(next.length === PAGE_SIZE)
            setSettled({ page, revision, error: false })
        }).catch(() => {
            if (cancelled) return
            setSettled({ page, revision, error: true })
        })
        return () => { cancelled = true }
    }, [rpcUrl, page, revision])

    useEffect(() => {
        if (!selected) return
        const item = items.find((offer) => offer.id === selected)
        if (!item) return
        let cancelled = false
        void getLaunchpadOfferQuote(rpcUrl, item).then((value) => {
            if (!cancelled) setQuote({ id: selected, value })
        }).catch(() => {
            if (!cancelled) setQuote({ id: selected, error: true })
        })
        return () => { cancelled = true }
    }, [rpcUrl, selected, items])

    const retry = () => setRevision((value) => value + 1)
    return <div className="os-stack">
        <p className="os-sub os-market-tab-description">A buyer funds each offer in full. Active escrow stays in the market until the owner accepts or the buyer exits; expired offers can be refunded to the buyer.</p>
        {loading && items.length === 0 && <Loading label="Loading Launchpad offers…" />}
        {error && <ErrorState message="Could not read offers from this network." onRetry={retry} />}
        {!loading && !error && items.length === 0 && <Empty title="No Launchpad offers have been created yet." />}
        {items.length > 0 && <div className="os-market-list" role="list">{items.map((item) => <article className="os-market-record" role="listitem" key={item.id}>
            <div className="os-market-record-core">
                <span className="os-market-token">{item.collection} <span aria-hidden="true">/</span> #{item.number.toString()}</span>
                <strong>{item.price.toLocaleString()} <small>{currencyLabel(item.currency)}</small></strong>
            </div>
            <div className="os-market-record-meta"><Pill tone={item.status === "active" ? "ok" : "neutral"}>{item.status}</Pill><span>DAO {formatBPS(item.protocolFeeBPS)} · Creator {formatBPS(item.royaltyBPS)}</span><span>Buyer {item.buyer.slice(0, 10)}{item.buyer.length > 10 ? "…" : ""}</span></div>
            <button type="button" className="os-btn os-quiet" aria-expanded={selected === item.id} onClick={() => { setSelected((id) => id === item.id ? null : item.id); setQuote(null) }}>{selected === item.id ? "Hide terms" : "Inspect terms"}</button>
            {selected === item.id && <div className="os-market-terms">
                <span>Buyer <code>{item.buyer}</code></span>
                <span>Currency <code>{item.currency}</code></span>
                <span>Offer {item.id} · Fee fixed at config version {item.configVersion.toString()}</span>
                <span>Expires {formatExpiry(item.expiresAt)}</span>
                {item.status === "cancelled" || item.status === "expired" ? <span>Escrow was returned to the buyer.</span> : item.status === "accepted" ? <span>Escrow was settled to the seller, DAO and royalty receivers.</span> : <span>The buyer can cancel this funded offer, including while trading is paused.</span>}
                {!quote || quote.id !== item.id || (!quote.value && !quote.error) ? <Loading label="Reading offer split…" /> : quote.error ? <span role="alert">Could not verify the current offer split.</span> : <>
                    <span>Seller receives {quote.value!.sellerAmount.toLocaleString()} · DAO receives {quote.value!.protocolAmount.toLocaleString()} · Creator royalties {quote.value!.royaltyTotal.toLocaleString()}</span>
                    <span>DAO treasury <code>{quote.value!.treasury}</code></span>
                    {quote.value!.royalties.map((receiver) => <span key={receiver.account}>Royalty {receiver.amount.toLocaleString()} to <code>{receiver.account}</code></span>)}
                    <span>{quote.value!.executable ? "Token and owner approval currently allow acceptance." : "Offer is not executable now."} Trading policy is checked again when accepting.</span>
                </>}
            </div>}
        </article>)}</div>}
        {loading && items.length > 0 && <Loading label="Loading more offers…" />}
        {!error && !loading && hasMore && <button type="button" className="os-btn os-quiet" onClick={() => setPage((value) => value + 1)}>Load more offers</button>}
    </div>
}

function currencyLabel(key: string): string { return key === "ugnot" ? "ugnot" : key.split(".").at(-1) ?? key }
function formatBPS(bps: bigint): string { return `${(Number(bps) / 100).toFixed(2)}%` }
function formatExpiry(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : `${seconds.toString()} Unix seconds`
}
