import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_CURATION_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "../../../lib/nftConfig"
import { MARKET_SPENDER, WUGNOT_KEY } from "../../../lib/launchpadTokenTrade"
import { clearGovernanceMemory, saveGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import MarketWindow from "./native"

const availability = vi.hoisted(() => ({ enabled: false, ledger: false, market: false, config: false, fees: false, curation: false, curationDao: false }))
const list = vi.hoisted(() => vi.fn())
const getQuote = vi.hoisted(() => vi.fn())
const policyReady = vi.hoisted(() => vi.fn())
const listOffers = vi.hoisted(() => vi.fn())
const getOfferQuote = vi.hoisted(() => vi.fn())
const getTokenOwner = vi.hoisted(() => vi.fn())
const getCurationState = vi.hoisted(() => vi.fn())
const listCurationManagers = vi.hoisted(() => vi.fn())
const listCurationApplications = vi.hoisted(() => vi.fn())
const getCollectionCuration = vi.hoisted(() => vi.fn())
const readCurationDaoSnapshot = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
const gasPrice = vi.hoisted(() => vi.fn(async () => ({ gas: 1000, ugnot: 1 })))
const readListingReadiness = vi.hoisted(() => vi.fn())
const readOfferReadiness = vi.hoisted(() => vi.fn())
const readNativeProceeds = vi.hoisted(() => vi.fn())
const readWugnotSpend = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/grc20", async (original) => ({ ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: gasPrice }))
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isNftEnabled: () => availability.enabled,
    isRealmValidOn: (_network: string, path: string) => path === LAUNCHPAD_NFT_PATH ? availability.ledger : path === LAUNCHPAD_MARKET_PATH ? availability.market : path === LAUNCHPAD_CONFIG_PATH ? availability.config : path === LAUNCHPAD_FEES_PATH ? availability.fees : path === LAUNCHPAD_CURATION_PATH ? availability.curation : path === LAUNCHPAD_CURATION_DAO_PATH ? availability.curationDao : false,
}))
vi.mock("../../../lib/launchpadMarket", () => ({ listLaunchpadMarketListings: list, getLaunchpadMarketQuote: getQuote,
    listLaunchpadMarketOffers: listOffers, getLaunchpadOfferQuote: getOfferQuote, getLaunchpadMarketTokenOwner: getTokenOwner,
    isLaunchpadMarketPolicyReady: policyReady }))
vi.mock("../../../lib/launchpadListing", async (original) => ({ ...(await original<typeof import("../../../lib/launchpadListing")>()), readListingReadiness }))
vi.mock("../../../lib/launchpadOfferTrade", async (original) => ({ ...(await original<typeof import("../../../lib/launchpadOfferTrade")>()), readOfferReadiness }))
vi.mock("../../../lib/launchpadProceeds", async (original) => ({ ...(await original<typeof import("../../../lib/launchpadProceeds")>()), readNativeProceeds }))
vi.mock("../../../lib/launchpadTokenTrade", async (original) => ({ ...(await original<typeof import("../../../lib/launchpadTokenTrade")>()), readWugnotSpend }))
vi.mock("../../../lib/launchpadCuration", () => ({ getCurationState, listCurationManagers, listCurationApplications, getCollectionCuration }))
vi.mock("../../../lib/launchpadCurationDao", () => ({ readCurationDaoSnapshot }))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

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
        availability.config = false
        availability.fees = false
        availability.curation = false
        availability.curationDao = false
        list.mockReset()
        getQuote.mockReset()
        policyReady.mockReset()
        policyReady.mockResolvedValue(true)
        listOffers.mockReset()
        getOfferQuote.mockReset()
        getTokenOwner.mockReset()
        getTokenOwner.mockResolvedValue(null)
        getCurationState.mockReset()
        listCurationManagers.mockReset()
        listCurationApplications.mockReset()
        getCollectionCuration.mockReset()
        readCurationDaoSnapshot.mockReset()
        sign.mockReset()
        gasPrice.mockClear()
        readListingReadiness.mockReset()
        readOfferReadiness.mockReset()
        readNativeProceeds.mockReset()
        readWugnotSpend.mockReset()
        localStorage.clear()
        clearGovernanceMemory()
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

    it("offers native purchase review to a member with current executable terms", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        const buyer = `g1${"q".repeat(38)}`
        const live = { ...item, seller: `g1${"p".repeat(38)}`, expiresAt: 4102444800n }
        const split = { ...quote, treasury: `g1${"z".repeat(38)}`, royalties: [{ account: `g1${"a".repeat(38)}`, amount: 500n }] }
        list.mockResolvedValue([live])
        getQuote.mockResolvedValue(split)
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: buyer, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review purchase" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        const request = sign.mock.calls[0][0]
        expect(request.prepare(undefined).msgs[0]).toMatchObject({ value: { caller: buyer, send: "10000ugnot", func: "Buy", args: ["L1", "2"] } })
        expect(request.lines(undefined)).toContainEqual(["Estimated gas fee", "60,000 ugnot"])
    })

    it("reviews exact WUGNOT approval separately from token-funded purchase", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        const buyer = `g1${"q".repeat(38)}`
        const seller = `g1${"p".repeat(38)}`
        const live = { ...item, seller, currency: WUGNOT_KEY, price: 1000n, expiresAt: 4102444800n }
        const split = { ...quote, currency: WUGNOT_KEY, price: 1000n, sellerAmount: 945n,
            protocolAmount: 5n, royaltyTotal: 50n, treasury: `g1${"t".repeat(38)}`,
            royalties: [{ account: `g1${"a".repeat(38)}`, amount: 50n }] }
        list.mockResolvedValue([live])
        getQuote.mockResolvedValue(split)
        const baseSpend = { currency: WUGNOT_KEY, owner: buyer, spender: MARKET_SPENDER, name: "wrapped GNOT",
            symbol: "wugnot", decimals: 0, balance: 1000n, allowance: 0n }
        readWugnotSpend.mockResolvedValue(baseSpend)
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: buyer, openConnect: vi.fn() } as never
        const view = render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review exact WUGNOT approval" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: buyer, send: "", func: "Approve", args: [MARKET_SPENDER, "1000"] } })
        view.unmount()
        sign.mockClear()
        readWugnotSpend.mockResolvedValue({ ...baseSpend, allowance: 1000n })
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review WUGNOT purchase" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: buyer, send: "", func: "Buy", args: ["L1", "2"] } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["DAO treasury", split.treasury])
    })

    it("blocks wallet review while policy is paused or a previous outcome is unresolved", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        const buyer = `g1${"q".repeat(38)}`
        const live = { ...item, seller: `g1${"p".repeat(38)}`, expiresAt: 4102444800n }
        const split = { ...quote, treasury: `g1${"z".repeat(38)}`, royalties: [{ account: `g1${"a".repeat(38)}`, amount: 500n }] }
        list.mockResolvedValue([live])
        getQuote.mockResolvedValue(split)
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: buyer, openConnect: vi.fn() } as never
        policyReady.mockResolvedValueOnce(false)
        const view = render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        expect(await screen.findByText(/Buying is unavailable under the current/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review purchase" })).toBeNull()
        view.unmount()
        saveGovernanceReceipt({ chainId: "test12", realmPath: LAUNCHPAD_MARKET_PATH, caller: buyer, operation: "buy:L1" },
            { phase: "submitted", hash: "ab".repeat(32), label: "Buy C4 #1" })
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        expect(await screen.findByText("Previous purchase outcome needs review")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review purchase" })).toBeNull()
        expect(sign).not.toHaveBeenCalled()
    })

    it("lets the seller review cancellation during a pause and locks an uncertain attempt", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        const seller = `g1${"p".repeat(38)}`
        const live = { ...item, seller, expiresAt: 4102444800n }
        list.mockResolvedValue([live])
        getQuote.mockRejectedValue(new Error("quote unavailable"))
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: seller, openConnect: vi.fn() } as never
        const view = render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review cancellation" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        const request = sign.mock.calls[0][0]
        expect(request.prepare(undefined).msgs[0]).toMatchObject({ value: { caller: seller, send: "", func: "Cancel", args: ["L1"] } })
        view.unmount()
        saveGovernanceReceipt({ chainId: "test12", realmPath: LAUNCHPAD_MARKET_PATH, caller: seller, operation: "cancel-listing:L1" },
            { phase: "submitted", hash: "ab".repeat(32), label: "Cancel listing L1" })
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        expect(await screen.findByText("Previous cancellation outcome needs review")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review cancellation" })).toBeNull()
    })

    it("checks owned Open token terms before offering exact approval and listing review", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        const seller = `g1${"p".repeat(38)}`
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: seller, openConnect: vi.fn() } as never
        const terms = { collection: { id: "C7", name: "Art", mode: "open", tradable: true, royaltyBPS: 500n,
            royalties: [{ account: `g1${"a".repeat(38)}`, bps: 500n }] }, number: 3n, owner: seller,
            approved: false, approvalScope: "none", currentListingID: "", configVersion: 4n, feeBPS: 50n, policyReady: true }
        readListingReadiness.mockResolvedValueOnce(terms)
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Sell" }))
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C7" } })
        fireEvent.change(screen.getByLabelText("Token number"), { target: { value: "3" } })
        fireEvent.click(screen.getByRole("button", { name: "Check token" }))
        expect(await screen.findByText(/This token needs approval/)).toBeInTheDocument()
        expect(readListingReadiness).toHaveBeenCalledWith(expect.any(String), "C7", 3n, seller)
        fireEvent.click(screen.getByRole("button", { name: "Review token approval" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: { caller: seller, func: "Approve", args: ["C7", expect.stringMatching(/^g1/), "3"] } })
    })

    it("reviews an exact native listing and discloses replacement of an existing sale", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        const seller = `g1${"p".repeat(38)}`
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: seller, openConnect: vi.fn() } as never
        const terms = { collection: { id: "C7", name: "Art", mode: "open", tradable: true, royaltyBPS: 500n,
            royalties: [{ account: `g1${"a".repeat(38)}`, bps: 500n }] }, number: 3n, owner: seller,
            approved: true, approvalScope: "token", currentListingID: "", configVersion: 4n, feeBPS: 50n, policyReady: true }
        readListingReadiness.mockResolvedValueOnce(terms).mockResolvedValueOnce({ ...terms, currentListingID: "L8" })
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Sell" }))
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C7" } })
        fireEvent.change(screen.getByLabelText("Token number"), { target: { value: "3" } })
        fireEvent.click(screen.getByRole("button", { name: "Check token" }))
        expect(await screen.findByText(/This token is approved/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Price (GNOT)"), { target: { value: "1.25" } })
        fireEvent.click(screen.getByRole("button", { name: "Review listing" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: seller, send: "", func: "List", args: ["C7", "3", "1250000", expect.any(String), "ugnot", "4"],
        } })
        fireEvent.click(screen.getByRole("button", { name: "Check token" }))
        expect(await screen.findByText(/Listing L8 exists for this token/)).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Review listing" })).toBeEnabled()
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

    it("offers a buyer refund while trading policy is unavailable", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        list.mockResolvedValue([])
        const buyer = `g1${"p".repeat(38)}`
        const funded = { ...offer, buyer, expiresAt: 4102444800n }
        listOffers.mockResolvedValue([funded])
        getOfferQuote.mockRejectedValue(new Error("quote unavailable"))
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: buyer, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(screen.getByRole("button", { name: "Review offer cancellation" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: { caller: buyer, send: "", func: "CancelOffer", args: ["O1"] } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["Refund recipient", buyer])
    })

    it("lets another member return expired escrow to the buyer and locks uncertainty", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        list.mockResolvedValue([])
        const buyer = `g1${"p".repeat(38)}`
        const helper = `g1${"q".repeat(38)}`
        const expired = { ...offer, buyer, expiresAt: 1000n }
        listOffers.mockResolvedValue([expired])
        getOfferQuote.mockResolvedValue({ ...offerQuote, offer: "O1" })
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: helper, openConnect: vi.fn() } as never
        const view = render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(screen.getByRole("button", { name: "Return expired escrow" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: { caller: helper, send: "", func: "ExpireOffer", args: ["O1"] } })
        view.unmount()
        saveGovernanceReceipt({ chainId: "test12", realmPath: LAUNCHPAD_MARKET_PATH, caller: helper, operation: "expire-offer:O1" },
            { phase: "submitted", hash: "ab".repeat(32), label: "Refund expired offer O1" })
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        expect(await screen.findByText("Previous offer refund outcome needs review")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Return expired escrow" })).toBeNull()
    })

    it("offers acceptance only to the current owner after a verified payout quote", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        const buyer = `g1${"p".repeat(38)}`
        const seller = `g1${"q".repeat(38)}`
        const funded = { ...offer, buyer, expiresAt: 4102444800n }
        const payout = { ...offerQuote, executable: true, treasury: `g1${"t".repeat(38)}`,
            royalties: [{ account: `g1${"a".repeat(38)}`, amount: 500n }] }
        listOffers.mockResolvedValue([funded])
        getOfferQuote.mockResolvedValue(payout)
        getTokenOwner.mockResolvedValue(seller)
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: seller, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        fireEvent.click(await screen.findByRole("button", { name: "Inspect terms" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review offer acceptance" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: seller, send: "", func: "AcceptOffer", args: ["O1", "4"] } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["DAO treasury", payout.treasury])
    })

    it("reviews a full native escrow deposit before funding a token-specific offer", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        listOffers.mockResolvedValue([])
        const buyer = `g1${"p".repeat(38)}`
        const owner = `g1${"q".repeat(38)}`
        readOfferReadiness.mockResolvedValue({ collection: { id: "C7", name: "Art", mode: "open", tradable: true,
            royaltyBPS: 500n, royalties: [{ account: `g1${"a".repeat(38)}`, bps: 500n }] },
            number: 3n, buyer, owner, configVersion: 4n, feeBPS: 50n, policyReady: true })
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: buyer, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Offers" }))
        fireEvent.change(screen.getByLabelText("Offer collection ID"), { target: { value: "C7" } })
        fireEvent.change(screen.getByLabelText("Offer token number"), { target: { value: "3" } })
        fireEvent.click(screen.getByRole("button", { name: "Check NFT" }))
        expect(await screen.findByText(/Current owner/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Offer price (GNOT)"), { target: { value: "1.25" } })
        fireEvent.click(screen.getByRole("button", { name: "Review funded offer" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        const request = sign.mock.calls[0][0]
        expect(request.prepare(undefined).msgs[0]).toMatchObject({ value: { caller: buyer, send: "1250000ugnot",
            func: "MakeOffer", args: ["C7", "3", "1250000", expect.any(String), "ugnot", "4"] } })
        expect(request.lines(undefined)).toContainEqual(["Escrow deposit", "1.25 GNOT (1,250,000 ugnot)"])
    })

    it("shows DAO proceeds and reviews only a personal receiver's claim", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        const treasury = `g1${"t".repeat(38)}`
        const member = `g1${"p".repeat(38)}`
        readNativeProceeds.mockResolvedValue({ configVersion: 4n, treasury, treasuryClaimable: 500n,
            member, memberClaimable: 100n, totalLiability: 900n })
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: member, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Proceeds" }))
        expect(await screen.findByText(/DAO treasury: 500 ugnot claimable/)).toBeInTheDocument()
        expect(screen.getByText(/Your claimable proceeds: 100 ugnot/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Review proceeds claim" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: member, send: "", func: "Claim", args: ["ugnot"] } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["Receiver and signer", member])
    })

    it("does not offer a single-wallet claim for the DAO reserve", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.market = true
        availability.config = true
        availability.fees = true
        list.mockResolvedValue([])
        const treasury = `g1${"t".repeat(38)}`
        readNativeProceeds.mockResolvedValue({ configVersion: 4n, treasury, treasuryClaimable: 500n,
            member: treasury, memberClaimable: 500n, totalLiability: 900n })
        const session = { network: { key: "testnet12", chainId: "test12" }, status: "member", address: treasury, openConnect: vi.fn() } as never
        render(<MarketWindow {...base} session={session} section="launchpad" open={vi.fn()} />)
        fireEvent.click(screen.getByRole("tab", { name: "Proceeds" }))
        expect(await screen.findByText(/Use the reserve signing ceremony/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review proceeds claim" })).toBeNull()
    })

    it("gates direct Operations links until the curation realm is allowlisted", () => {
        availability.enabled = true
        availability.ledger = true
        render(<MarketWindow {...base} section="operations" open={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaiting the governed curation realm")
        expect(getCurationState).not.toHaveBeenCalled()
        expect(readCurationDaoSnapshot).not.toHaveBeenCalled()
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
        expect(readCurationDaoSnapshot).not.toHaveBeenCalled()
    })

    it("shows versioned DAO decisions only when its realm is allowlisted", async () => {
        availability.enabled = true
        availability.ledger = true
        availability.curation = true
        availability.curationDao = true
        getCurationState.mockResolvedValue({ admin: "g1dao", pendingAdmin: "", governed: true, activeManagers: 0 })
        listCurationManagers.mockResolvedValue([])
        listCurationApplications.mockResolvedValue([])
        readCurationDaoSnapshot.mockResolvedValue({ successor: "g1successor", total: "1", nextBefore: null, proposals: [{ id: "1", proposer: "g1proposer", status: "EXECUTED", votingDeadline: "2026-09-28T00:00:00Z", action: { operation: "appoint-manager", collection: "", manager: "g1manager", reasonHash: "", verified: false } }] })
        render(<MarketWindow {...base} section="operations" open={vi.fn()} />)
        expect(await screen.findByRole("heading", { name: "DAO curation proposals" })).toBeInTheDocument()
        expect(await screen.findByText("Proposal 1")).toBeInTheDocument()
        expect(screen.getByText("Appoint manager")).toBeInTheDocument()
        expect(readCurationDaoSnapshot).toHaveBeenCalledWith(expect.any(String), "0")
        expect(screen.queryByRole("button", { name: /Vote|Execute|Appoint manager/ })).toBeNull()
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
