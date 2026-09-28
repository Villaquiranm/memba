/** Native Token Launchpad reads. Transactions remain gated by their deployed realms. */
import { useState } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { GNO_CHAIN_ID, GRC20_FACTORY_PATH, NETWORKS, isRealmValidOn } from "../../../lib/config"
import { TokenLaunchpadClient, TOKEN_LAUNCHPAD_PATH, type LaunchpadToken } from "../../../lib/tokenLaunchpadClient"
import { TokenLaunchpadSalesClient, TOKEN_LAUNCHPAD_SALES_PATH, type LaunchpadSaleView } from "../../../lib/tokenLaunchpadSalesClient"
import { TokenLaunchpadPoolClient, TOKEN_LAUNCHPAD_POOL_PATH } from "../../../lib/tokenLaunchpadPoolClient"
import { Pill } from "../../kit"
import type { NativeViewProps } from "../../native/types"
import "./native.css"

function tokenAmount(amount: bigint, decimals: number): string {
    if (decimals === 0) return amount.toString()
    const digits = amount.toString().padStart(decimals + 1, "0")
    const fraction = digits.slice(-decimals).replace(/0+$/, "")
    return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "")
}

function saleIdentityMatches(token: LaunchpadToken | undefined, sale: LaunchpadSaleView | undefined): boolean {
    if (!token || !sale) return false
    const embedded = sale.token
    return token.id === embedded.id && token.registryKey === embedded.registryKey &&
        token.grc20Id === embedded.grc20Id && token.creator === embedded.creator &&
        token.mode === embedded.mode && token.name === embedded.name &&
        token.ticker === embedded.ticker && token.decimals === embedded.decimals &&
        token.initialSupply === embedded.initialSupply && token.maxSupply === embedded.maxSupply &&
        token.currencyKey === embedded.currencyKey && token.configVersion === embedded.configVersion &&
        (!sale.curve || (token.mode === "curve" && sale.curve.creator === token.creator &&
            sale.curve.quoteCurrency === token.currencyKey && sale.curve.configVersion === token.configVersion)) &&
        (!sale.fairSale || (sale.fairSale.creator === token.creator && sale.fairSale.configVersion > 0n &&
            (token.mode !== "fairsale" || (sale.fairSale.quoteCurrency === token.currencyKey &&
                sale.fairSale.configVersion === token.configVersion))))
}

export default function TokensWindow({ section, session, fallback }: NativeViewProps) {
    const network = session.network.key
    const factoryAvailable = isRealmValidOn(network, GRC20_FACTORY_PATH)
    if (section !== null && factoryAvailable) return <>{fallback}</>
    if (isRealmValidOn(network, TOKEN_LAUNCHPAD_PATH)) {
        return <LaunchpadTokens network={network} address={session.status === "member" ? session.address : null} salesAvailable={isRealmValidOn(network, TOKEN_LAUNCHPAD_SALES_PATH)} poolAvailable={isRealmValidOn(network, TOKEN_LAUNCHPAD_POOL_PATH)} legacyFallback={factoryAvailable ? fallback : null} />
    }
    if (factoryAvailable) return <>{fallback}</>
    const chainId = NETWORKS[network]?.chainId ?? GNO_CHAIN_ID

    return (
        <div className="os-stack">
            <div className="os-note os-warn" role="note">
                <Pill tone="neutral">Token creation unavailable here</Pill>{" "}
                Memba&rsquo;s token factory and creation screens are implemented, but the factory is {network === "mainnet" ? "not deployed" : "not available"} on {chainId}. Creation and Memba factory-token listings are unavailable here.
            </div>
        </div>
    )
}

function LaunchpadTokens({ network, address, salesAvailable, poolAvailable, legacyFallback }: { network: string; address: string | null; salesAvailable: boolean; poolAvailable: boolean; legacyFallback: ReactNode }) {
    const [page, setPage] = useState(0)
    const [selected, setSelected] = useState<string | null>(null)
    const [vestingIndex, setVestingIndex] = useState(0)
    const [showLegacy, setShowLegacy] = useState(false)
    const tokenClient = new TokenLaunchpadClient(network)
    const salesClient = new TokenLaunchpadSalesClient(network)
    const poolClient = new TokenLaunchpadPoolClient(network)
    const tokens = useQuery({
        queryKey: ["token-launchpad", network, "page", page],
        queryFn: () => tokenClient.listPage(page, 20),
        retry: false,
    })
    const launch = useQuery({
        queryKey: ["token-launchpad", network, "launch", selected],
        queryFn: () => salesClient.launch(selected!),
        enabled: salesAvailable && selected !== null,
        retry: false,
    })
    const selectedToken = tokens.data?.find(token => token.id === selected)
    const saleMatches = saleIdentityMatches(selectedToken, launch.data)
    const buyer = useQuery({
        queryKey: ["token-launchpad", network, "buyer", selected, address],
        queryFn: () => salesClient.fairBuyer(selected!, address!),
        enabled: salesAvailable && saleMatches && !!selected && !!address && !!launch.data?.fairSale,
        retry: false,
    })
    const pool = useQuery({
        queryKey: ["token-launchpad", network, "pool", selected],
        queryFn: () => poolClient.pool(selected!),
        enabled: poolAvailable && saleMatches && !!selected && launch.data?.curve?.status === "graduated",
        retry: false,
    })
    const balance = useQuery({
        queryKey: ["token-launchpad", network, "balance", selected, address],
        queryFn: () => tokenClient.balanceOf(selected!, address!),
        enabled: !!selected && !!address,
        retry: false,
    })
    const vesting = useQuery({
        queryKey: ["token-launchpad", network, "vesting", selected, vestingIndex],
        queryFn: () => salesClient.vesting(selected!, vestingIndex),
        enabled: salesAvailable && saleMatches && !!selected && vestingIndex < (launch.data?.vestingCount ?? 0),
        retry: false,
    })
    const poolMatches = saleMatches && !!pool.data && !!selectedToken && !!launch.data?.curve &&
        pool.data.id === selectedToken.id && pool.data.creator === selectedToken.creator &&
        pool.data.creator === launch.data.curve.creator &&
        pool.data.quoteCurrency === selectedToken.currencyKey &&
        pool.data.quoteCurrency === launch.data.curve.quoteCurrency &&
        pool.data.configVersion === selectedToken.configVersion &&
        pool.data.configVersion === launch.data.curve.configVersion
    const choose = (id: string) => { setSelected(id); setVestingIndex(0) }

    return <div className="os-stack os-token-launchpad">
        <div>
            <h2>Token Launchpad</h2>
            <p className="os-sub">Browse registered tokens and their on-chain launch state.</p>
        </div>
        {legacyFallback && <div>
            <button type="button" className="os-btn os-quiet" aria-expanded={showLegacy} onClick={() => setShowLegacy(!showLegacy)}>{showLegacy ? "Hide existing token factory" : "Open existing token factory"}</button>
            {showLegacy && <div className="os-token-launchpad__legacy os-classic">{legacyFallback}</div>}
        </div>}
        {tokens.isPending && <p role="status">Loading tokens…</p>}
        {tokens.isError && <div className="os-note os-err" role="alert">Tokens could not be loaded. <button type="button" className="os-btn os-quiet" onClick={() => void tokens.refetch()}>Retry</button></div>}
        {tokens.isSuccess && tokens.data.length === 0 && <p className="os-sub">No tokens on this page.</p>}
        {tokens.data && <ul className="os-token-launchpad__list" aria-label="Launchpad tokens">{tokens.data.map(token => <li key={token.id}>
            <button type="button" className="os-token-launchpad__token" aria-pressed={selected === token.id} onClick={() => choose(token.id)}>
                <span><b>{token.name}</b> <span className="os-sub">{token.ticker}</span></span>
                <span className="os-sub">{token.id} · {token.mode.replaceAll("_", " ")}</span>
            </button>
        </li>)}</ul>}
        <div className="os-row">
            <button type="button" className="os-btn os-quiet" disabled={page === 0 || tokens.isFetching} onClick={() => { setPage(page - 1); setSelected(null) }}>Previous</button>
            <span className="os-sub">Page {page + 1}</span>
            <button type="button" className="os-btn os-quiet" disabled={!tokens.data || tokens.data.length < 20 || tokens.isFetching} onClick={() => { setPage(page + 1); setSelected(null) }}>Next</button>
        </div>
        {selectedToken && <section className="os-card" aria-label={`${selectedToken.name} details`}>
            <h3>{selectedToken.name} ({selectedToken.ticker})</h3>
            <dl className="os-token-launchpad__facts">
                <div><dt>Token ID</dt><dd>{selectedToken.id}</dd></div>
                <div><dt>Network</dt><dd>{NETWORKS[network]?.chainId ?? GNO_CHAIN_ID}</dd></div>
                <div><dt>Registry key</dt><dd>{selectedToken.registryKey}</dd></div>
                <div><dt>Registered GRC20 ID</dt><dd>{selectedToken.grc20Id}</dd></div>
                <div><dt>Creator</dt><dd>{selectedToken.creator}</dd></div>
                <div><dt>Supply</dt><dd>{tokenAmount(selectedToken.totalSupply, selectedToken.decimals)} {selectedToken.ticker}</dd></div>
                <div><dt>Currency</dt><dd>{selectedToken.currencyKey}</dd></div>
            </dl>
            {address && balance.isPending && <p role="status">Loading your token balance…</p>}
            {address && balance.isError && <p className="os-note os-err" role="alert">Your token balance could not be loaded. <button type="button" className="os-btn os-quiet" onClick={() => void balance.refetch()}>Retry balance</button></p>}
            {address && balance.data !== undefined && <p>Your balance: {tokenAmount(balance.data, selectedToken.decimals)} {selectedToken.ticker}.</p>}
            {!salesAvailable && <p className="os-note" role="status">Sales details are unavailable on this network.</p>}
            {salesAvailable && launch.isPending && <p role="status">Loading sale details…</p>}
            {salesAvailable && launch.isError && <p className="os-note os-err" role="alert">Sale details could not be loaded. <button type="button" className="os-btn os-quiet" onClick={() => void launch.refetch()}>Retry</button></p>}
            {launch.data && !saleMatches && <p className="os-note os-err" role="alert">Sale identity does not match this token.</p>}
            {launch.data && saleMatches && <div className="os-token-launchpad__sections">
                {launch.data.curve && <div>
                    <h4>Bonding curve</h4>
                    <p>Status: {launch.data.curve.status}. Raised {launch.data.curve.raised.toString()} of {launch.data.curve.graduationTarget.toString()} base units of {launch.data.curve.quoteCurrency}; {tokenAmount(launch.data.curve.sold, selectedToken.decimals)} {selectedToken.ticker} sold.</p>
                    {launch.data.curve.status === "graduated" && <div>
                        <h4>Locked pool</h4>
                        {!poolAvailable && <p className="os-sub">Pool details are unavailable on this network.</p>}
                        {poolAvailable && pool.isPending && <p role="status">Loading pool reserves…</p>}
                        {poolAvailable && pool.isError && <p className="os-note os-err" role="alert">Pool reserves could not be loaded. <button type="button" className="os-btn os-quiet" onClick={() => void pool.refetch()}>Retry pool</button></p>}
                        {pool.data && !poolMatches && <p className="os-note os-err" role="alert">Pool identity does not match this launch.</p>}
                        {poolMatches && pool.data && <p>Recorded reserves: {tokenAmount(pool.data.tokenReserve, selectedToken.decimals)} {selectedToken.ticker} and {pool.data.quoteReserve.toString()} base units of {pool.data.quoteCurrency}. These assets have no withdrawal claim.</p>}
                    </div>}
                </div>}
                {launch.data.fairSale && <div>
                    <h4>Fair sale</h4>
                    <p>{launch.data.fairSale.cancelled ? "Cancelled" : launch.data.fairSale.settled ? launch.data.fairSale.succeeded ? "Succeeded" : "Refunding" : "Open or awaiting settlement"}. {launch.data.fairSale.totalLots.toString()} of {launch.data.fairSale.hardCapLots.toString()} lots filled.</p>
                    {launch.data.fairSale.settled && <p>Final price {launch.data.fairSale.closePrice.toString()} base units of {launch.data.fairSale.quoteCurrency} per lot. {launch.data.fairSale.proceedsReleased ? "Proceeds released." : "Proceeds pending."}</p>}
                    {address && buyer.isPending && <p role="status">Loading your sale claim…</p>}
                    {address && buyer.isError && <p className="os-note os-err" role="alert">Your sale claim could not be loaded.</p>}
                    {buyer.data && <p>Your claim: {tokenAmount(buyer.data.claimableTokens, selectedToken.decimals)} {selectedToken.ticker} and {buyer.data.claimableRefund.toString()} base units of {launch.data.fairSale.quoteCurrency} refund{buyer.data.claimed ? " (claimed)" : ""}.</p>}
                </div>}
                {launch.data.airdrop && <div>
                    <h4>Airdrop</h4>
                    <p>{tokenAmount(launch.data.airdrop.claimed, selectedToken.decimals)} of {tokenAmount(launch.data.airdrop.total, selectedToken.decimals)} {selectedToken.ticker} claimed.</p>
                </div>}
                {launch.data.vestingCount > 0 && <div>
                    <h4>Vesting</h4>
                    <p>{launch.data.vestingCount} schedule{launch.data.vestingCount === 1 ? "" : "s"}</p>
                    {vesting.data && <p>Schedule {vesting.data.index + 1}: {tokenAmount(vesting.data.claimed, selectedToken.decimals)} of {tokenAmount(vesting.data.total, selectedToken.decimals)} {selectedToken.ticker} claimed by {vesting.data.beneficiary}.</p>}
                    {vesting.isError && <p className="os-note os-err" role="alert">Vesting details could not be loaded.</p>}
                    <div className="os-row">
                        <button type="button" className="os-btn os-quiet" disabled={vestingIndex === 0} onClick={() => setVestingIndex(vestingIndex - 1)}>Previous schedule</button>
                        <button type="button" className="os-btn os-quiet" disabled={vestingIndex + 1 >= launch.data.vestingCount} onClick={() => setVestingIndex(vestingIndex + 1)}>Next schedule</button>
                    </div>
                </div>}
                {!launch.data.curve && !launch.data.fairSale && !launch.data.airdrop && launch.data.vestingCount === 0 && <p className="os-sub">No sale, airdrop or vesting campaign is recorded.</p>}
            </div>}
        </section>}
    </div>
}
