import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "../../../lib/nftConfig"
import MarketWindow from "./native"

const availability = vi.hoisted(() => ({ enabled: false, ledger: false, market: false }))
const list = vi.hoisted(() => vi.fn())
const getQuote = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isNftEnabled: () => availability.enabled,
    isRealmValidOn: (_network: string, path: string) => path === LAUNCHPAD_NFT_PATH ? availability.ledger : path === LAUNCHPAD_MARKET_PATH ? availability.market : false,
}))
vi.mock("../../../lib/launchpadMarket", () => ({ listLaunchpadMarketListings: list, getLaunchpadMarketQuote: getQuote }))

const item = { id: "L1", collection: "C4", number: 1n, seller: "g1seller", price: 10000n, currency: "ugnot",
    expiresAt: 1000n, createdAt: 500n, configVersion: 2n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" }
const quote = { listing: "L1", price: 10000n, currency: "ugnot", sellerAmount: 9450n,
    protocolAmount: 50n, royaltyTotal: 500n, treasury: "g1treasury", currentConfigVersion: 2n,
    executable: true, royalties: [{ account: "g1artist", amount: 500n }] }
const base = { query: undefined, close: () => {}, toast: () => {}, openApp: () => {}, fallback: <p>classic market</p>,
    session: { network: { key: "testnet12" } } as never }

describe("native Market window", () => {
    beforeEach(() => {
        availability.enabled = false
        availability.ledger = false
        availability.market = false
        list.mockReset()
        getQuote.mockReset()
    })

    it("keeps existing Market sections in their current lane", () => {
        render(<MarketWindow {...base} section="nfts" open={vi.fn()} />)
        expect(screen.getByText("classic market")).toBeInTheDocument()
    })

    it("shows a native home with services and a gated Launchpad lane", () => {
        const open = vi.fn()
        render(<MarketWindow {...base} section={null} open={open} />)
        expect(screen.getByRole("heading", { name: "Trade with the full story" })).toBeInTheDocument()
        expect(screen.getByText("Awaiting Launchpad publication")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /Services/ }))
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "app", app: "market", section: "services" } }))
    })

    it("does not query an unpublished market even on a direct Launchpad link", () => {
        availability.enabled = true
        availability.ledger = true
        render(<MarketWindow {...base} section="launchpad" open={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("not available on this network")
        expect(list).not.toHaveBeenCalled()
    })

    it("reads real records and a fresh on-chain split without exposing a buy button", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        list.mockResolvedValue([item])
        getQuote.mockResolvedValue(quote)
        render(<MarketWindow {...base} section="launchpad" open={vi.fn()} />)
        expect(await screen.findByText(/C4/)).toBeInTheDocument()
        expect(screen.getByText(/DAO 0.50%/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Inspect terms" }))
        await waitFor(() => expect(screen.getByText(/Seller receives 9,450/)).toBeInTheDocument())
        expect(screen.getByText(/g1treasury/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /Buy/ })).toBeNull()
        expect(list).toHaveBeenCalledWith(expect.any(String), 0, 20)
        expect(getQuote).toHaveBeenCalledWith(expect.any(String), item)
    })

    it("reports read failures rather than claiming an empty market", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        list.mockRejectedValue(new Error("RPC unavailable"))
        render(<MarketWindow {...base} section="launchpad" open={vi.fn()} />)
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not read sale records")
        expect(screen.queryByText("No Launchpad sale records have been created yet.")).toBeNull()
    })
})
