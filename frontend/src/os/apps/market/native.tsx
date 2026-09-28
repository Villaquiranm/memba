/** Native Market desk for Launchpad records and the existing service lane. */
import { useEffect, useState } from "react"
import type { NativeViewProps } from "../../native/types"
import { GNO_RPC_URL, NETWORKS, isNftEnabled, isRealmValidOn } from "../../../lib/config"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "../../../lib/nftConfig"
import { LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_CURATION_PATH } from "../../../lib/nftConfig"
import { getLaunchpadMarketQuote, getLaunchpadOfferQuote, isLaunchpadMarketPolicyReady, listLaunchpadMarketListings, listLaunchpadMarketOffers, type LaunchpadMarketListing, type LaunchpadMarketOffer, type LaunchpadMarketQuote, type LaunchpadOfferQuote } from "../../../lib/launchpadMarket"
import { BUY_GAS_WANTED, CANCEL_GAS_WANTED, buyLaunchpadNativeRequest, buyScope, cancelLaunchpadListingRequest, cancelListingScope } from "../../../lib/launchpadTrade"
import { APPROVE_GAS_WANTED, LIST_GAS_WANTED, approveListingRequest, approveListingScope, createListingRequest, createListingScope, parseGnotPrice, readListingReadiness, type ListingReadiness } from "../../../lib/launchpadListing"
import { OFFER_REFUND_GAS_WANTED, offerExitRequest, offerExitScope, type OfferExit } from "../../../lib/launchpadOfferExit"
import { MAKE_OFFER_GAS_WANTED, makeNativeOfferRequest, makeOfferScope, readOfferReadiness, type OfferReadiness } from "../../../lib/launchpadOfferTrade"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { clearGovernanceReceipt, readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import { useSigner } from "../../sign/signerContext"
import { Empty, ErrorState, Loading, Pill } from "../../kit"
import { specForTarget } from "../../shell/windows"
import MarketOperations from "./operations"
import "./native.css"

const PAGE_SIZE = 20

export default function MarketWindow({ section, session, open, toast, fallback }: NativeViewProps) {
    if (section !== null && section !== "launchpad" && section !== "operations") return <>{fallback}</>

    const network = session.network.key
    const rpcUrl = NETWORKS[network]?.rpcUrl ?? GNO_RPC_URL
    const available = isNftEnabled() && isRealmValidOn(network, LAUNCHPAD_NFT_PATH) && isRealmValidOn(network, LAUNCHPAD_MARKET_PATH)
    const tradingAvailable = available && isRealmValidOn(network, LAUNCHPAD_CONFIG_PATH) && isRealmValidOn(network, LAUNCHPAD_FEES_PATH)
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
            ? <LaunchpadMarket key={network} rpcUrl={rpcUrl} openServices={openServices} session={session} tradingAvailable={tradingAvailable} toast={toast} />
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

function LaunchpadMarket({ rpcUrl, openServices, session, tradingAvailable, toast }: { rpcUrl: string; openServices: () => void; session: NativeViewProps["session"]; tradingAvailable: boolean; toast: (message: string) => void }) {
    const [tab, setTab] = useState<"listings" | "offers" | "sell">("listings")
    return <div className="os-stack os-market-records">
        <header className="os-market-records-head">
            <div><h1>Collectibles</h1><p className="os-sub">Listings and funded offers from the Launchpad market realm. Prices are raw currency units; quotes come from chain.</p></div>
            <button type="button" className="os-btn os-quiet" onClick={openServices}>Services</button>
        </header>
        <div className="os-note" role="note">{tradingAvailable ? "Native-currency buying, listing and funded offers are available after wallet review." : "Trading awaits the reviewed policy and proceeds realms on this network."} Sellers can cancel active listings and buyers can exit funded offers during a market pause. Offer acceptance and token payments remain in preparation. Ownership, approval and policy are checked again before settlement.</div>
        <div className="os-market-tabs" role="tablist" aria-label="Collectible market records">
            <button type="button" role="tab" aria-selected={tab === "listings"} onClick={() => setTab("listings")}>Listings</button>
            <button type="button" role="tab" aria-selected={tab === "offers"} onClick={() => setTab("offers")}>Offers</button>
            <button type="button" role="tab" aria-selected={tab === "sell"} onClick={() => setTab("sell")}>Sell</button>
        </div>
        {tab === "listings" ? <LaunchpadListings rpcUrl={rpcUrl} session={session} tradingAvailable={tradingAvailable} toast={toast} /> :
            tab === "offers" ? <LaunchpadOffers rpcUrl={rpcUrl} session={session} tradingAvailable={tradingAvailable} toast={toast} /> :
                <ListingComposer key={session.status === "member" ? session.address : "visitor"} rpcUrl={rpcUrl} session={session} tradingAvailable={tradingAvailable} toast={toast} />}
    </div>
}

function ListingComposer({ rpcUrl, session, tradingAvailable, toast }: {
    rpcUrl: string; session: NativeViewProps["session"]; tradingAvailable: boolean; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [collectionID, setCollectionID] = useState("")
    const [numberText, setNumberText] = useState("")
    const [priceText, setPriceText] = useState("")
    const [days, setDays] = useState(7)
    const [readiness, setReadiness] = useState<ListingReadiness | null>(null)
    const [checking, setChecking] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [error, setError] = useState("")
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    if (!tradingAvailable) return <div className="os-note os-warn" role="note">Listing needs the reviewed market, policy and proceeds realms on this network.</div>
    if (session.status !== "member") return <div className="os-stack"><p>Connect a wallet to list a Launchpad NFT you own.</p><button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>

    const refresh = () => {
        if (!readiness) return
        setChecking(true)
        void readListingReadiness(rpcUrl, readiness.collection.id, readiness.number, session.address).then((fresh) => {
            setReadiness(fresh); setError("")
        }).catch((cause) => { setReadiness(null); setError(cause instanceof Error ? cause.message : "Could not verify this NFT.") })
            .finally(() => setChecking(false))
    }
    const scope = readiness && createListingScope(session.network.chainId, session.address, readiness.collection.id, readiness.number)
    const approvalScope = readiness && approveListingScope(session.network.chainId, session.address, readiness.collection.id, readiness.number)
    const receipt = scope && readGovernanceReceipt(scope)
    const approvalReceipt = approvalScope && readGovernanceReceipt(approvalScope)
    const locked = receipt || approvalReceipt
    const lockedScope = receipt ? scope : approvalReceipt ? approvalScope : null

    const review = (kind: "approve" | "list") => {
        if (!readiness) return
        setPreparing(true)
        void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
            if (kind === "approve") {
                const estimatedGasFeeUgnot = feeForGasWanted(APPROVE_GAS_WANTED, gasPrice)
                signer.sign(approveListingRequest({ readiness, rpcUrl, chainId: session.network.chainId,
                    estimatedGasFeeUgnot, onSettled: refresh }))
            } else {
                const price = parseGnotPrice(priceText)
                const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400)
                const estimatedGasFeeUgnot = feeForGasWanted(LIST_GAS_WANTED, gasPrice)
                signer.sign(createListingRequest({ readiness, price, expiresAt, rpcUrl,
                    chainId: session.network.chainId, estimatedGasFeeUgnot, onSettled: refresh }))
            }
        }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare this listing."))
            .finally(() => setPreparing(false))
    }
    return <section className="os-stack" aria-label="List a Launchpad NFT">
        <div><h2>Sell a collectible</h2><p className="os-sub">Approve one Open NFT for Market, then set a fixed native price. SoulBound assets cannot be listed.</p></div>
        <label>Collection ID <input value={collectionID} placeholder="C1" disabled={checking || preparing} onChange={(event) => { setCollectionID(event.target.value.trim()); setReadiness(null); setError("") }} /></label>
        <label>Token number <input value={numberText} inputMode="numeric" placeholder="1" disabled={checking || preparing} onChange={(event) => { setNumberText(event.target.value.trim()); setReadiness(null); setError("") }} /></label>
        <button type="button" className="os-btn os-quiet" disabled={checking} onClick={() => {
            if (!/^C[1-9]\d*$/.test(collectionID) || !/^[1-9]\d*$/.test(numberText)) { setError("Enter a collection ID and positive token number."); return }
            setChecking(true); setError("")
            void readListingReadiness(rpcUrl, collectionID, BigInt(numberText), session.address).then(setReadiness)
                .catch((cause) => { setReadiness(null); setError(cause instanceof Error ? cause.message : "Could not verify this NFT.") })
                .finally(() => setChecking(false))
        }}>{checking ? "Checking chain…" : "Check token"}</button>
        {error && <p role="alert">{error}</p>}
        {readiness && <div className="os-stack os-note">
            <strong>{readiness.collection.name} · {readiness.collection.id} #{readiness.number.toString()}</strong>
            <span>Owner <code>{readiness.owner}</code></span>
            <span>Approval: {readiness.approvalScope === "collection" ? "Collection-wide approval already exists" : readiness.approved ? "This token is approved" : "This token needs approval"}</span>
            <span>DAO trading fee: {formatBPS(readiness.feeBPS)} · Creator royalties: {formatBPS(readiness.collection.royaltyBPS)}</span>
            <span>Market policy: {readiness.policyReady ? "ready" : "paused or unavailable"}</span>
            {readiness.currentListingID && <span>Listing {readiness.currentListingID} exists for this token. A new listing will replace it; review both terms carefully.</span>}
            {locked && lockedScope ? <div className="os-stack os-tight os-note os-warn" role="status">
                <strong>Previous {receipt ? "listing" : "approval"} outcome needs review</strong>
                <span>Check the transaction and current chain state before another attempt.</span>
                {locked.hash && (txExplorerUrl(locked.hash, session.network.chainId)
                    ? <a href={txExplorerUrl(locked.hash, session.network.chainId)!} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{locked.hash}</code>)}
                <button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh token</button>
                <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and know whether this action executed.</label>
                <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                    try { clearGovernanceReceipt(lockedScope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                    catch { /* an in-flight wallet request keeps the receipt locked */ }
                }}>Review a new attempt</button>
            </div> : !readiness.approved ? <button type="button" className="os-btn" disabled={preparing || !readiness.policyReady} onClick={() => review("approve")}>{preparing ? "Preparing review…" : "Review token approval"}</button> : <>
                <label>Price (GNOT) <input value={priceText} inputMode="decimal" placeholder="1.25" onChange={(event) => setPriceText(event.target.value.trim())} /></label>
                <label>Listing duration <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                    <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
                </select></label>
                <button type="button" className="os-btn" disabled={preparing || !readiness.policyReady} onClick={() => review("list")}>{preparing ? "Preparing review…" : "Review listing"}</button>
            </>}
        </div>}
    </section>
}

function LaunchpadListings({ rpcUrl, session, tradingAvailable, toast }: { rpcUrl: string; session: NativeViewProps["session"]; tradingAvailable: boolean; toast: (message: string) => void }) {
    const signer = useSigner()
    const [items, setItems] = useState<LaunchpadMarketListing[]>([])
    const [page, setPage] = useState(0)
    const [revision, setRevision] = useState(0)
    const [settled, setSettled] = useState({ page: -1, revision: -1, error: false })
    const [hasMore, setHasMore] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    const [quote, setQuote] = useState<{ id: string; value?: LaunchpadMarketQuote; policyReady?: boolean; error?: boolean } | null>(null)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [preparing, setPreparing] = useState<string | null>(null)
    const [, refreshReceipt] = useState(0)
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
        void Promise.all([getLaunchpadMarketQuote(rpcUrl, item), tradingAvailable ? isLaunchpadMarketPolicyReady(rpcUrl, item.currency) : Promise.resolve(false)]).then(([value, policyReady]) => {
            if (!cancelled) setQuote({ id: selected, value, policyReady })
        }).catch(() => {
            if (!cancelled) setQuote({ id: selected, error: true })
        })
        return () => { cancelled = true }
    }, [rpcUrl, selected, items, tradingAvailable])

    const retry = () => setRevision((value) => value + 1)
    const refresh = () => { setPage(0); setRevision((value) => value + 1) }
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
            <button type="button" className="os-btn os-quiet" aria-expanded={selected === item.id} onClick={() => { setSelected((id) => id === item.id ? null : item.id); setQuote(null); setCheckedOutcome(false) }}>{selected === item.id ? "Hide terms" : "Inspect terms"}</button>
            {selected === item.id && <div className="os-market-terms">
                <span>Seller <code>{item.seller}</code></span>
                <span>Currency <code>{item.currency}</code></span>
                <span>Listing {item.id} · Fee fixed at config version {item.configVersion.toString()}</span>
                {session.status === "member" && session.address === item.seller && item.status === "active" &&
                    <CancelListingAction listing={item} session={session} rpcUrl={rpcUrl} refresh={refresh} toast={toast} />}
                {!quote || quote.id !== item.id || (!quote.value && !quote.error) ? <Loading label="Reading sale split…" /> : quote.error ? <span role="alert">Could not verify the current sale split.</span> : <>
                    <span>Seller receives {quote.value!.sellerAmount.toLocaleString()} · DAO receives {quote.value!.protocolAmount.toLocaleString()} · Creator royalties {quote.value!.royaltyTotal.toLocaleString()}</span>
                    <span>DAO treasury <code>{quote.value!.treasury}</code></span>
                    {quote.value!.royalties.map((receiver) => <span key={receiver.account}>Royalty {receiver.amount.toLocaleString()} to <code>{receiver.account}</code></span>)}
                    <span>{quote.value!.executable ? "Token and approval currently match the listing." : "Listing is not executable now."} Trading policy is checked again when buying.</span>
                    {(() => {
                        const current = quote.value!
                        if (item.currency !== "ugnot" || item.status !== "active") return null
                        if (!current.executable || !quote.policyReady || item.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) return <span>Buying is unavailable under the current token or trading policy. Refresh its terms.</span>
                        if (session.status === "member" && session.address === item.seller) return <span>You own this listing.</span>
                        if (session.status !== "member") return <button type="button" className="os-btn" onClick={session.openConnect}>Connect to buy</button>
                        const scope = buyScope(session.network.chainId, session.address, item.id)
                        const receipt = readGovernanceReceipt(scope)
                        if (receipt) {
                            const link = receipt.hash ? txExplorerUrl(receipt.hash, session.network.chainId) : null
                            return <div className="os-stack os-tight os-note os-warn" role="status">
                                <strong>Previous purchase outcome needs review</strong>
                                <span>Check the transaction and token owner before trying this listing again.</span>
                                {receipt.hash && (link ? <a href={link} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
                                <button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh record</button>
                                <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and this purchase did not execute.</label>
                                <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                                    try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                                    catch { /* an in-flight wallet request keeps the receipt locked */ }
                                }}>Review a new attempt</button>
                            </div>
                        }
                        return <button type="button" className="os-btn" disabled={preparing === item.id} onClick={() => {
                            setPreparing(item.id)
                            void networkGasPrice(session.network.chainId, [rpcUrl]).then((price) => {
                                const estimatedGasFeeUgnot = feeForGasWanted(BUY_GAS_WANTED, price)
                                signer.sign(buyLaunchpadNativeRequest({ listing: item, quote: current, caller: session.address, rpcUrl, chainId: session.network.chainId, estimatedGasFeeUgnot, onSettled: refresh }))
                            }).catch((error) => {
                                toast(error instanceof Error ? error.message : "Could not prepare this purchase.")
                                refresh()
                            }).finally(() => setPreparing(null))
                        }}>{preparing === item.id ? "Preparing review…" : "Review purchase"}</button>
                    })()}
                </>}
            </div>}
        </article>)}</div>}
        {loading && items.length > 0 && <Loading label="Loading more sale records…" />}
        {!error && !loading && hasMore && <button type="button" className="os-btn os-quiet" onClick={() => setPage((value) => value + 1)}>Load more records</button>}
    </div>
}

function CancelListingAction({ listing, session, rpcUrl, refresh, toast }: {
    listing: LaunchpadMarketListing
    session: NativeViewProps["session"]
    rpcUrl: string
    refresh: () => void
    toast: (message: string) => void
}) {
    const signer = useSigner()
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    if (session.status !== "member" || session.address !== listing.seller) return null
    const scope = cancelListingScope(session.network.chainId, session.address, listing.id)
    const receipt = readGovernanceReceipt(scope)
    if (receipt) {
        const link = receipt.hash ? txExplorerUrl(receipt.hash, session.network.chainId) : null
        return <div className="os-stack os-tight os-note os-warn" role="status">
            <strong>Previous cancellation outcome needs review</strong>
            <span>Check the transaction and listing status before another attempt.</span>
            {receipt.hash && (link ? <a href={link} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
            <button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh record</button>
            <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and this cancellation did not execute.</label>
            <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                catch { /* an in-flight wallet request keeps the receipt locked */ }
            }}>Review a new cancellation</button>
        </div>
    }
    return <button type="button" className="os-btn os-quiet" disabled={preparing} onClick={() => {
        setPreparing(true)
        void networkGasPrice(session.network.chainId, [rpcUrl]).then((price) => {
            const estimatedGasFeeUgnot = feeForGasWanted(CANCEL_GAS_WANTED, price)
            signer.sign(cancelLaunchpadListingRequest({ listing, caller: session.address, rpcUrl,
                chainId: session.network.chainId, estimatedGasFeeUgnot, onSettled: refresh }))
        }).catch((error) => {
            toast(error instanceof Error ? error.message : "Could not prepare this cancellation.")
            refresh()
        }).finally(() => setPreparing(false))
    }}>{preparing ? "Preparing cancellation…" : "Review cancellation"}</button>
}

function LaunchpadOffers({ rpcUrl, session, tradingAvailable, toast }: { rpcUrl: string; session: NativeViewProps["session"]; tradingAvailable: boolean; toast: (message: string) => void }) {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
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
        const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
        return () => window.clearInterval(timer)
    }, [])

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
    const refresh = () => { setPage(0); setRevision((value) => value + 1) }
    return <div className="os-stack">
        <p className="os-sub os-market-tab-description">A buyer funds each offer in full. Active escrow stays in the market until the owner accepts or the buyer exits; expired offers can be refunded to the buyer.</p>
        {tradingAvailable && <MakeOfferComposer key={session.status === "member" ? session.address : "visitor"} session={session} rpcUrl={rpcUrl} refresh={refresh} toast={toast} />}
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
                {item.status === "active" && (session.status === "member" ?
                    <OfferExitAction key={`${session.address}:${item.id}`} offer={item} session={session} rpcUrl={rpcUrl} refresh={refresh} toast={toast} now={now} /> :
                    item.expiresAt <= BigInt(now) ? <button type="button" className="os-btn os-quiet" onClick={session.openConnect}>Connect to return expired escrow</button> : null)}
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

function MakeOfferComposer({ session, rpcUrl, refresh, toast }: {
    session: NativeViewProps["session"]; rpcUrl: string; refresh: () => void; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [collectionID, setCollectionID] = useState("")
    const [numberText, setNumberText] = useState("")
    const [priceText, setPriceText] = useState("")
    const [days, setDays] = useState(7)
    const [readiness, setReadiness] = useState<OfferReadiness | null>(null)
    const [checking, setChecking] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [error, setError] = useState("")
    const [, refreshReceipt] = useState(0)
    if (session.status !== "member") return <div className="os-note">Connect a wallet to make a funded offer on an Open NFT. <button type="button" className="os-btn os-quiet" onClick={session.openConnect}>Connect wallet</button></div>

    const scope = readiness && makeOfferScope(session.network.chainId, session.address, readiness.collection.id, readiness.number)
    const receipt = scope && readGovernanceReceipt(scope)
    const check = () => {
        if (!/^C[1-9]\d*$/.test(collectionID) || !/^[1-9]\d*$/.test(numberText)) { setError("Enter a collection ID and positive token number."); return }
        setChecking(true); setError("")
        void readOfferReadiness(rpcUrl, collectionID, BigInt(numberText), session.address).then(setReadiness)
            .catch((cause) => { setReadiness(null); setError(cause instanceof Error ? cause.message : "Could not verify this NFT.") })
            .finally(() => setChecking(false))
    }
    return <section className="os-stack os-note" aria-label="Make a funded NFT offer">
        <div><h2>Make a funded offer</h2><p className="os-sub">Your full price moves into market escrow now. The NFT owner can accept it while the offer is active.</p></div>
        <label>Offer collection ID <input value={collectionID} placeholder="C1" disabled={checking || preparing} onChange={(event) => { setCollectionID(event.target.value.trim()); setReadiness(null); setError("") }} /></label>
        <label>Offer token number <input value={numberText} inputMode="numeric" placeholder="1" disabled={checking || preparing} onChange={(event) => { setNumberText(event.target.value.trim()); setReadiness(null); setError("") }} /></label>
        <button type="button" className="os-btn os-quiet" disabled={checking} onClick={check}>{checking ? "Checking chain…" : "Check NFT"}</button>
        {error && <p role="alert">{error}</p>}
        {readiness && <div className="os-stack os-tight">
            <strong>{readiness.collection.name} · {readiness.collection.id} #{readiness.number.toString()}</strong>
            <span>Current owner <code>{readiness.owner}</code></span>
            <span>DAO trading fee: {formatBPS(readiness.feeBPS)} · Creator royalties: {formatBPS(readiness.collection.royaltyBPS)}</span>
            <span>Market policy: {readiness.policyReady ? "ready" : "paused or unavailable"}</span>
            {receipt && scope ? <div className="os-stack os-tight os-note os-warn" role="status">
                <strong>Previous funded-offer outcome needs review</strong>
                <span>Check the transaction and offer records before funding another offer for this NFT.</span>
                {receipt.hash && (txExplorerUrl(receipt.hash, session.network.chainId)
                    ? <a href={txExplorerUrl(receipt.hash, session.network.chainId)!} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
                <button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh offers</button>
                <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and know whether this offer was funded.</label>
                <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                    try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                    catch { /* an in-flight wallet request keeps the receipt locked */ }
                }}>Review a new offer</button>
            </div> : <>
                <label>Offer price (GNOT) <input value={priceText} inputMode="decimal" placeholder="1.25" onChange={(event) => setPriceText(event.target.value.trim())} /></label>
                <label>Offer duration <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                    <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
                </select></label>
                <button type="button" className="os-btn" disabled={preparing || !readiness.policyReady} onClick={() => {
                    setPreparing(true)
                    void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
                        const price = parseGnotPrice(priceText)
                        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400)
                        const estimatedGasFeeUgnot = feeForGasWanted(MAKE_OFFER_GAS_WANTED, gasPrice)
                        signer.sign(makeNativeOfferRequest({ readiness, price, expiresAt, rpcUrl, chainId: session.network.chainId,
                            estimatedGasFeeUgnot, onSettled: refresh }))
                    }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare this offer."))
                        .finally(() => setPreparing(false))
                }}>{preparing ? "Preparing review…" : "Review funded offer"}</button>
            </>}
        </div>}
    </section>
}

function OfferExitAction({ offer, session, rpcUrl, refresh, toast, now }: {
    offer: LaunchpadMarketOffer; session: NativeViewProps["session"]; rpcUrl: string;
    refresh: () => void; toast: (message: string) => void; now: number
}) {
    const signer = useSigner()
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    if (session.status !== "member") return null
    const action: OfferExit | null = session.address === offer.buyer ? "cancel" :
        offer.expiresAt <= BigInt(now) ? "expire" : null
    if (!action) return null
    const scope = offerExitScope(session.network.chainId, session.address, offer.id, action)
    const receipt = readGovernanceReceipt(scope)
    if (receipt) {
        const link = receipt.hash ? txExplorerUrl(receipt.hash, session.network.chainId) : null
        return <div className="os-stack os-tight os-note os-warn" role="status">
            <strong>Previous offer refund outcome needs review</strong>
            <span>Check the transaction, offer status and buyer balance before another attempt.</span>
            {receipt.hash && (link ? <a href={link} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
            <button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh offer</button>
            <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and this refund did not execute.</label>
            <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                catch { /* an in-flight wallet request keeps the receipt locked */ }
            }}>Review a new refund attempt</button>
        </div>
    }
    return <button type="button" className="os-btn os-quiet" disabled={preparing} onClick={() => {
        setPreparing(true)
        void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
            const estimatedGasFeeUgnot = feeForGasWanted(OFFER_REFUND_GAS_WANTED, gasPrice)
            signer.sign(offerExitRequest({ offer, caller: session.address, action, rpcUrl,
                chainId: session.network.chainId, estimatedGasFeeUgnot, onSettled: refresh }))
        }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare this refund."))
            .finally(() => setPreparing(false))
    }}>{preparing ? "Preparing refund…" : action === "cancel" ? "Review offer cancellation" : "Return expired escrow"}</button>
}

function currencyLabel(key: string): string { return key === "ugnot" ? "ugnot" : key.split(".").at(-1) ?? key }
function formatBPS(bps: bigint): string { return `${(Number(bps) / 100).toFixed(2)}%` }
function formatExpiry(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : `${seconds.toString()} Unix seconds`
}
