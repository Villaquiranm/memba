/** Native Token Launchpad reads. Transactions remain gated by their deployed realms. */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { GNO_CHAIN_ID, GRC20_FACTORY_PATH, NETWORKS, isRealmValidOn } from "../../../lib/config"
import { TokenLaunchpadClient, TOKEN_LAUNCHPAD_PATH } from "../../../lib/tokenLaunchpadClient"
import { TokenLaunchpadSalesClient, TOKEN_LAUNCHPAD_SALES_PATH } from "../../../lib/tokenLaunchpadSalesClient"
import { Pill } from "../../kit"
import type { NativeViewProps } from "../../native/types"
import "./native.css"

export default function TokensWindow({ session, fallback }: NativeViewProps) {
    const network = session.network.key
    if (isRealmValidOn(network, TOKEN_LAUNCHPAD_PATH)) {
        return <LaunchpadTokens network={network} address={session.status === "member" ? session.address : null} salesAvailable={isRealmValidOn(network, TOKEN_LAUNCHPAD_SALES_PATH)} />
    }
    if (isRealmValidOn(network, GRC20_FACTORY_PATH)) return <>{fallback}</>
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

function LaunchpadTokens({ network, address, salesAvailable }: { network: string; address: string | null; salesAvailable: boolean }) {
    const [page, setPage] = useState(0)
    const [selected, setSelected] = useState<string | null>(null)
    const [vestingIndex, setVestingIndex] = useState(0)
    const tokenClient = new TokenLaunchpadClient(network)
    const salesClient = new TokenLaunchpadSalesClient(network)
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
    const buyer = useQuery({
        queryKey: ["token-launchpad", network, "buyer", selected, address],
        queryFn: () => salesClient.fairBuyer(selected!, address!),
        enabled: salesAvailable && !!selected && !!address && !!launch.data?.fairSale,
        retry: false,
    })
    const vesting = useQuery({
        queryKey: ["token-launchpad", network, "vesting", selected, vestingIndex],
        queryFn: () => salesClient.vesting(selected!, vestingIndex),
        enabled: salesAvailable && !!selected && vestingIndex < (launch.data?.vestingCount ?? 0),
        retry: false,
    })
    const selectedToken = tokens.data?.find(token => token.id === selected)
    const choose = (id: string) => { setSelected(id); setVestingIndex(0) }

    return <div className="os-stack os-token-launchpad">
        <div>
            <h2>Token Launchpad</h2>
            <p className="os-sub">Browse registered tokens and their on-chain launch state.</p>
        </div>
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
                <div><dt>Creator</dt><dd>{selectedToken.creator}</dd></div>
                <div><dt>Supply</dt><dd>{selectedToken.totalSupply.toString()}</dd></div>
                <div><dt>Currency</dt><dd>{selectedToken.currencyKey}</dd></div>
            </dl>
            {!salesAvailable && <p className="os-note" role="status">Sales details are unavailable on this network.</p>}
            {salesAvailable && launch.isPending && <p role="status">Loading sale details…</p>}
            {salesAvailable && launch.isError && <p className="os-note os-err" role="alert">Sale details could not be loaded. <button type="button" className="os-btn os-quiet" onClick={() => void launch.refetch()}>Retry</button></p>}
            {launch.data && <div className="os-token-launchpad__sections">
                {launch.data.curve && <div>
                    <h4>Bonding curve</h4>
                    <p>Status: {launch.data.curve.status}. Raised {launch.data.curve.raised.toString()} of {launch.data.curve.graduationTarget.toString()} {launch.data.curve.quoteCurrency}; {launch.data.curve.sold.toString()} tokens sold.</p>
                </div>}
                {launch.data.fairSale && <div>
                    <h4>Fair sale</h4>
                    <p>{launch.data.fairSale.cancelled ? "Cancelled" : launch.data.fairSale.settled ? launch.data.fairSale.succeeded ? "Succeeded" : "Refunding" : "Open or awaiting settlement"}. {launch.data.fairSale.totalLots.toString()} of {launch.data.fairSale.hardCapLots.toString()} lots filled.</p>
                    {launch.data.fairSale.settled && <p>Final price {launch.data.fairSale.closePrice.toString()} {launch.data.fairSale.quoteCurrency} per lot. {launch.data.fairSale.proceedsReleased ? "Proceeds released." : "Proceeds pending."}</p>}
                    {address && buyer.isPending && <p role="status">Loading your sale claim…</p>}
                    {address && buyer.isError && <p className="os-note os-err" role="alert">Your sale claim could not be loaded.</p>}
                    {buyer.data && <p>Your claim: {buyer.data.claimableTokens.toString()} tokens and {buyer.data.claimableRefund.toString()} {launch.data.fairSale.quoteCurrency} refund{buyer.data.claimed ? " (claimed)" : ""}.</p>}
                </div>}
                {launch.data.airdrop && <div>
                    <h4>Airdrop</h4>
                    <p>{launch.data.airdrop.claimed.toString()} of {launch.data.airdrop.total.toString()} tokens claimed.</p>
                </div>}
                {launch.data.vestingCount > 0 && <div>
                    <h4>Vesting</h4>
                    <p>{launch.data.vestingCount} schedule{launch.data.vestingCount === 1 ? "" : "s"}</p>
                    {vesting.data && <p>Schedule {vesting.data.index + 1}: {vesting.data.claimed.toString()} of {vesting.data.total.toString()} claimed by {vesting.data.beneficiary}.</p>}
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
