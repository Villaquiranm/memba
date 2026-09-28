import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LAUNCHPAD_CURATION_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "../../../lib/nftConfig"
import MarketWindow from "./native"

const availability = vi.hoisted(() => ({ enabled: false, ledger: false, market: false, curation: false }))
const list = vi.hoisted(() => vi.fn())
const getQuote = vi.hoisted(() => vi.fn())
const listOffers = vi.hoisted(() => vi.fn())
const getOfferQuote = vi.hoisted(() => vi.fn())
const getCurationState = vi.hoisted(() => vi.fn())
const listCurationManagers = vi.hoisted(() => vi.fn())
const listCurationApplications = vi.hoisted(() => vi.fn())
const getCollectionCuration = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isNftEnabled: () => availability.enabled,
    isRealmValidOn: (_network: string, path: string) => path === LAUNCHPAD_NFT_PATH ? availability.ledger : path === LAUNCHPAD_MARKET_PATH ? availability.market : path === LAUNCHPAD_CURATION_PATH ? availability.curation : false,
}))
vi.mock("../../../lib/launchpadMarket", () => ({ listLaunchpadMarketListings: list, getLaunchpadMarketQuote: getQuote,
    listLaunchpadMarketOffers: listOffers, getLaunchpadOfferQuote: getOfferQuote }))
vi.mock("../../../lib/launchpadCuration", () => ({ getCurationState, listCurationManagers, listCurationApplications, getCollectionCuration }))

const item = { id: "L1", collection: "C4", number: 1n, seller: "g1seller", price: 10000n, currency: "ugnot",
    expiresAt: 1000n, createdAt: 500n, configVersion: 2n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" }
const quote = { listing: "L1", price: 10000n, currency: "ugnot", sellerAmount: 9450n,
    protocolAmount: 50n, royaltyTotal: 500n, treasury: "g1treasury", currentConfigVersion: 2n,
    executable: true, royalties: [{ account: "g1artist", amount: 500n }] }
const offer = { id: "O1", collection: "C4", number: 1n, buyer: "g1buyer", price: 10000n, currency: "ugnot",
    expiresAt: 2000000000n, createdAt: 1000000000n, configVersion: 3n, protocolFeeBPS: 200n,
    royaltyBPS: 500n, status: "active" }
const offerQuote = { offer: "O1", price: 10000n, currency: "ugnot", sellerAmount: 9300n,
    protocolAmount: 200n, royaltyTotal: 500n, treasury: "g1treasury", currentConfigVersion: 4n,
    executable: false, royalties: [{ account: "g1artist", amount: 500n }] }
const base = { query: undefined, close: () => {}, toast: () => {}, openApp: () => {}, fallback: <p>classic market</p>,
    session: { network: { key: "testnet12" } } as never }

describe("native Market window", () => {
    beforeEach(() => {
        availability.enabled = false
        availability.ledger = false
        availability.market = false
        availability.curation = false
        list.mockReset()
        getQuote.mockReset()
        listOffers.mockReset()
        getOfferQuote.mockReset()
        getCurationState.mockReset()
        listCurationManagers.mockReset()
        listCurationApplications.mockReset()
        getCollectionCuration.mockReset()
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

    it("shows funded offers and a fresh split in a separate read-only tab", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        list.mockResolvedValue([])
        listOffers.mockResolvedValue([offer])
        getOfferQuote.mockResolvedValue(offerQuote)
        render(<MarketWindow {...base} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        expect(await screen.findByText(/g1buyer/)).toBeInTheDocument()
        expect(screen.getByText(/DAO 2.00%/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Inspect terms" }))
        await waitFor(() => expect(screen.getByText(/Seller receives 9,300/)).toBeInTheDocument())
        expect(screen.getByText(/The buyer can cancel this funded offer/)).toBeInTheDocument()
        expect(screen.getByText(/Offer is not executable now/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /Accept offer|Cancel offer/ })).toBeNull()
        expect(listOffers).toHaveBeenCalledWith(expect.any(String), 0, 20)
        expect(getOfferQuote).toHaveBeenCalledWith(expect.any(String), offer)
    })

    it("gates direct Operations links until the curation realm is allowlisted", () => {
        availability.enabled = true
        availability.ledger = true
        render(<MarketWindow {...base} section="operations" open={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaiting the governed curation realm")
        expect(getCurationState).not.toHaveBeenCalled()
    })

    it("shows DAO seats, applications and a public curation receipt", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.curation = true
        getCurationState.mockResolvedValue({ admin: "g1dao", pendingAdmin: "", governed: true, activeManagers: 1 })
        listCurationManagers.mockResolvedValue([{ account: "g1manager", lead: true, until: "2000000000", active: true }])
        listCurationApplications.mockResolvedValue([{ collection: "C1", founder: "g1founder", statementHash: "a".repeat(64), revision: "1", status: "recommended", reviewer: "g1manager", reasonHash: "b".repeat(64), updatedAt: "1000000000" }])
        getCollectionCuration.mockResolvedValue({ collection: "C1", featured: true, hidden: false,
            feature: { proposer: "g1manager", approver: "g1other", reasonHash: "c".repeat(64), until: "2000000000", approvedAt: "1000000000" },
            hold: null, verification: { verified: true, reasonHash: "d".repeat(64), updatedAt: "1000000000" } })
        render(<MarketWindow {...base} section="operations" open={vi.fn()} />)
        expect(await screen.findByText("1 of 5 active seats")).toBeInTheDocument()
        expect(screen.getByText(/g1founder/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "View record" }))
        await waitFor(() => expect(screen.getByText(/DAO verification:/)).toBeInTheDocument())
        expect(screen.getByText(/Verified/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /Approve|Reject|Verify/ })).toBeNull()
    })

    it("reports Operations read failures without inventing an empty review queue", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.curation = true
        getCurationState.mockRejectedValue(new Error("RPC unavailable"))
        listCurationManagers.mockResolvedValue([])
        listCurationApplications.mockResolvedValue([])
        render(<MarketWindow {...base} section="operations" open={vi.fn()} />)
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify curation records")
        expect(screen.queryByText("No founder applications yet.")).toBeNull()
    })
})
