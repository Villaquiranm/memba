/**
 * NFT (v1.1) native home: collections, the launchpad and the studio are this
 * app's own, but buying and selling is Market's (owner decision 09-25) — the
 * classic /nft page used to redirect there, leaving this window empty. On
 * networks without an enabled collection registry, the home explains the
 * separate build flag and realm gates; elsewhere it offers its own sections
 * plus a shortcut into Market's NFT listings. Launchpad creation and fixed
 * drop scheduling have native sections; remaining sections use `fallback`.
 *
 * @module os/apps/nft/native
 */
import { useEffect, useState } from "react"
import type { NativeViewProps } from "../../native/types"
import { GNO_CHAIN_ID, GNO_RPC_URL, NETWORKS, isNftEnabled, isRealmValidOn } from "../../../lib/config"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH, NFT_COLLECTIONS_PATH, NFT_MARKETPLACE_V3_PATH } from "../../../lib/nftConfig"
import { listLaunchpadNftCollections, type LaunchpadNftCollection } from "../../../lib/launchpadNft"
import { getLaunchpadNftCapabilities, type LaunchpadNftCapabilities } from "../../../lib/launchpadNftCapabilities"
import { Card, CardGrid, Empty, ErrorState, Loading, Pill } from "../../kit"
import { Icon } from "../../shell/icons"
import { specForTarget } from "../../shell/windows"
import CreateLaunchpadCollection from "./create"
import LaunchpadCreatorStudio from "./studio"
import MintLaunchpadNFT from "./mint"
import ManageLaunchpadToken from "./manage"
import LaunchpadHoldings from "./holdings"

export default function NftWindow({ section, query, session, open, openApp, fallback, toast }: NativeViewProps) {
    if (section === "create" && isNftEnabled() && isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)) {
        return <CreateLaunchpadCollection key={session.network.key} rpcUrl={NETWORKS[session.network.key]?.rpcUrl ?? GNO_RPC_URL}
            session={session} available={[LAUNCHPAD_NFT_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH]
                .every((path) => isRealmValidOn(session.network.key, path))} toast={toast} />
    }
    if (section === "studio" && isNftEnabled() && isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)) {
        return <LaunchpadCreatorStudio key={session.network.key} rpcUrl={NETWORKS[session.network.key]?.rpcUrl ?? GNO_RPC_URL}
            session={session} available={[LAUNCHPAD_NFT_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH]
                .every((path) => isRealmValidOn(session.network.key, path))} toast={toast} />
    }
    if (section === "mint" && isNftEnabled() && isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)) {
        return <MintLaunchpadNFT key={session.network.key} rpcUrl={NETWORKS[session.network.key]?.rpcUrl ?? GNO_RPC_URL}
            session={session} available={[LAUNCHPAD_NFT_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH]
                .every((path) => isRealmValidOn(session.network.key, path))} toast={toast} />
    }
    if (section === "manage" && isNftEnabled() && isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)) {
        return <ManageLaunchpadToken key={`${session.network.key}:${query ?? ""}`} rpcUrl={NETWORKS[session.network.key]?.rpcUrl ?? GNO_RPC_URL}
            session={session} query={query} available={isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)} toast={toast} />
    }
    if (section === "holdings" && isNftEnabled() && isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)) {
        return <LaunchpadHoldings key={`${session.network.chainId}:${session.status === "member" ? session.address : "guest"}`} session={session} open={open} />
    }
    if (section !== null) return <>{fallback}</>

    const enabled = isNftEnabled()
    const chainId = NETWORKS[session.network.key]?.chainId ?? GNO_CHAIN_ID
    const legacyAvailable = isRealmValidOn(session.network.key, NFT_COLLECTIONS_PATH)
    const ledgerAvailable = isRealmValidOn(session.network.key, LAUNCHPAD_NFT_PATH)
    const marketAvailable = isRealmValidOn(session.network.key, NFT_MARKETPLACE_V3_PATH)
    const launchpadMarketAvailable = isRealmValidOn(session.network.key, LAUNCHPAD_MARKET_PATH)
    if (!enabled || (!legacyAvailable && !ledgerAvailable)) {
        return (
            <div className="os-stack">
                <div className="os-note os-warn" role="note">
                    <Pill tone="neutral">NFT unavailable here</Pill>{" "}
                    The collection and studio screens are implemented in Memba.
                    {!legacyAvailable && !ledgerAvailable && (session.network.key === "mainnet"
                        ? ` The collection registry is not deployed on ${chainId}.`
                        : " The collection registry is not available on this network.")}
                    {!enabled && " NFT features are disabled in this build."}
                    {enabled && !legacyAvailable && !ledgerAvailable && " Collection actions stay unavailable until the registry is available."}
                </div>
                <CardGrid>
                    <Card onClick={() => openApp("market")}>
                        <Icon name="tag" />
                        <span className="os-grow"><b>Open Market</b><span className="os-sub os-block">Browse the available Market lanes</span></span>
                    </Card>
                </CardGrid>
            </div>
        )
    }

    return (
        <div className="os-stack">
            <p className="os-sub">{legacyAvailable
                ? `The collection registry is available on this network. Buying and selling happens in Market${marketAvailable ? "." : " when its trading realm is available."}`
                : "The Launchpad NFT ledger is available on this network. Trading for these collections is not available yet."}</p>
            <CardGrid>
                {legacyAvailable && marketAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "market", section: "nfts" })!)}>
                    <Icon name="tag" />
                    <span className="os-grow"><b>Browse NFTs</b><span className="os-sub os-block">Collections and listings, in Market</span></span>
                </Card>}
                {ledgerAvailable && launchpadMarketAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "market", section: "launchpad" })!)}>
                    <Icon name="tag" />
                    <span className="os-grow"><b>Launchpad sale records</b><span className="os-sub os-block">Inspect listings and on-chain fee splits in Market</span></span>
                </Card>}
                {ledgerAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "create" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Create a Launchpad collection</b><span className="os-sub os-block">Review permanent rights and the DAO fee</span></span>
                </Card>}
                {ledgerAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "studio" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Creator Studio</b><span className="os-sub os-block">Schedule and inspect primary drop stages</span></span>
                </Card>}
                {ledgerAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "mint" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Mint from a drop</b><span className="os-sub os-block">Check eligibility and claim one NFT</span></span>
                </Card>}
                {ledgerAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "manage" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Manage an NFT</b><span className="os-sub os-block">Check ownership, transfer or retire a token</span></span>
                </Card>}
                {ledgerAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "holdings" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Your collectibles</b><span className="os-sub os-block">See confirmed holdings for your wallet</span></span>
                </Card>}
                {legacyAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "create" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Create a collection</b><span className="os-sub os-block">Launch a new NFT collection</span></span>
                </Card>}
                {legacyAvailable && <Card onClick={() => open(specForTarget({ kind: "app", app: "nft", section: "studio" })!)}>
                    <Icon name="nft" />
                    <span className="os-grow"><b>Your studio</b><span className="os-sub os-block">Manage what you've minted</span></span>
                </Card>}
            </CardGrid>
            {ledgerAvailable && <LaunchpadCollections key={session.network.key} rpcUrl={NETWORKS[session.network.key]?.rpcUrl ?? GNO_RPC_URL} />}
        </div>
    )
}

const PAGE_SIZE = 20

function LaunchpadCollections({ rpcUrl }: { rpcUrl: string }) {
    const [items, setItems] = useState<LaunchpadNftCollection[]>([])
    const [page, setPage] = useState(0)
    const [revision, setRevision] = useState(0)
    const [settled, setSettled] = useState({ page: -1, revision: -1, error: false })
    const [hasMore, setHasMore] = useState(false)
    const loading = settled.page !== page || settled.revision !== revision
    const error = !loading && settled.error

    useEffect(() => {
        let cancelled = false
        void listLaunchpadNftCollections(rpcUrl, page, PAGE_SIZE).then((next) => {
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

    const retry = () => setRevision((value) => value + 1)
    return <section aria-label="Launchpad NFT collections" className="os-stack">
        <div>
            <h2>Launchpad collections</h2>
            <p className="os-sub">Ownership and transfer rules come from the collection ledger. SoulBound collections cannot be traded.</p>
        </div>
        {loading && items.length === 0 && <Loading label="Loading Launchpad collections…" />}
        {error && <ErrorState message="Could not read Launchpad collections from this network." onRetry={retry} />}
        {!loading && !error && items.length === 0 && <Empty title="No Launchpad collections have been created yet." />}
        {items.length > 0 && <CardGrid min={260}>{items.map((item) => <Card key={item.id}>
            <span className="os-grow">
                <b>{item.name}</b>
                <span className="os-sub os-block">{item.symbol} · {item.id} · {item.creator.slice(0, 10)}…</span>
                <span className="os-sub os-block">{item.totalSupply.toString()} active · {item.minted.toString()} minted · {item.maxSupply === 0n ? "uncapped edition" : `${item.maxSupply.toString()} maximum`}</span>
                <Pill tone={item.mode === "soulbound" ? "neutral" : "ok"}>{item.mode === "soulbound" ? "SoulBound" : item.mode === "royalty_protected" ? "Royalty protected" : "Open"}</Pill>
                {item.mode === "soulbound" && item.revocable && <span className="os-sub os-block">Creator revocable</span>}
                <span className="os-sub os-block">Metadata: {item.revealed ? "revealed" : "hidden behind a placeholder"} · {item.metadataFrozen ? "frozen" : "not frozen"}</span>
                <span className="os-sub os-block">Royalty terms: {item.royaltyBPS.toString()} bps{item.royaltyBPS > 0n ? " · recorded for future market settlement" : " · none recorded"}</span>
                <details>
                    <summary>Collection terms</summary>
                    <span className="os-sub os-block">URI commitment is recorded on chain. File contents and provenance have not been verified by Memba.</span>
                    {item.royalties.length > 0 && <span className="os-sub os-block">Royalty payments cannot be assumed for transfers outside a marketplace.</span>}
                    {item.royalties.map((receiver) => <span key={receiver.account} className="os-sub os-block">Royalty {receiver.bps.toString()} bps → <code style={{ overflowWrap: "anywhere" }}>{receiver.account}</code></span>)}
                    <span className="os-sub os-block">Base URI SHA-256: <code style={{ overflowWrap: "anywhere" }}>{item.baseURICommitment}</code></span>
                    {item.provenanceHash && <span className="os-sub os-block">Creator provenance hash: <code style={{ overflowWrap: "anywhere" }}>{item.provenanceHash}</code></span>}
                    {!item.revealed && <span className="os-sub os-block">Placeholder: <code style={{ overflowWrap: "anywhere" }}>{item.placeholderURI}</code></span>}
                    <CapabilityInspector rpcUrl={rpcUrl} item={item} />
                </details>
            </span>
        </Card>)}</CardGrid>}
        {loading && items.length > 0 && <Loading label="Loading more collections…" />}
        {!error && !loading && hasMore && <button type="button" className="os-btn os-quiet" onClick={() => setPage((value) => value + 1)}>Load more collections</button>}
    </section>
}

function CapabilityInspector({ rpcUrl, item }: { rpcUrl: string; item: LaunchpadNftCollection }) {
    const [revision, setRevision] = useState(0)
    const [requested, setRequested] = useState(false)
    const [result, setResult] = useState<{ value?: LaunchpadNftCapabilities; error?: boolean; revision: number } | null>(null)
    useEffect(() => {
        if (!requested) return
        let cancelled = false
        void getLaunchpadNftCapabilities(rpcUrl, item).then((value) => {
            if (!cancelled) setResult({ value, revision })
        }).catch(() => { if (!cancelled) setResult({ error: true, revision }) })
        return () => { cancelled = true }
    }, [rpcUrl, item, requested, revision])
    return <div className="os-stack">
        <button type="button" className="os-btn os-quiet" onClick={() => { setRequested(true); setRevision((value) => value + 1) }}>Check current rights</button>
        {requested && (!result || result.revision !== revision) && <Loading label="Checking collection rights…" />}
        {requested && result?.revision === revision && result.error && <span role="alert">Could not verify this collection’s rights from chain.</span>}
        {requested && result?.revision === revision && result.value && <div className="os-stack">
            <span className="os-sub">Transfer: {result.value.transferable ? "allowed" : "blocked"} · Approvals: {result.value.approvable ? "allowed" : "blocked"} · Holder burn: allowed</span>
            <span className="os-sub">Issuer revoke: {result.value.issuerRevoke ? "allowed under the collection policy" : "not allowed"} · Recipient claim: {result.value.recipientClaimRequired ? "required" : "not required"}</span>
            <span className="os-sub">Native market mode: {result.value.nativeMarketModeEligible ? "eligible" : "ineligible"}. A live sale also requires current ownership, approval and market policy.</span>
            <span className="os-sub">Royalties: {result.value.royaltyScope === "native_market_only" ? "paid by native marketplace settlements; off-market transfers may not pay" : "none recorded"}</span>
            <span className="os-sub">Metadata: {result.value.canReveal ? "committed reveal still available" : "no further reveal available"} · {result.value.metadataFrozen ? "frozen" : "not frozen"}</span>
        </div>}
    </div>
}
