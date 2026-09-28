import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TokensWindow from "./native"

const availability = vi.hoisted(() => ({ factory: false, launchpad: false, sales: false }))
const listPage = vi.hoisted(() => vi.fn())
const launch = vi.hoisted(() => vi.fn())
const fairBuyer = vi.hoisted(() => vi.fn())
const vesting = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/tokenLaunchpadClient", () => ({
    TOKEN_LAUNCHPAD_PATH: "gno.land/r/samcrew/launchpad/tokens/v1",
    TokenLaunchpadClient: class { listPage = listPage },
}))
vi.mock("../../../lib/tokenLaunchpadSalesClient", () => ({
    TOKEN_LAUNCHPAD_SALES_PATH: "gno.land/r/samcrew/launchpad/sales/v1",
    TokenLaunchpadSalesClient: class { launch = launch; fairBuyer = fairBuyer; vesting = vesting },
}))
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isRealmValidOn: (_network: string, path: string) => path === "gno.land/r/samcrew/launchpad/tokens/v1" ? availability.launchpad : path === "gno.land/r/samcrew/launchpad/sales/v1" ? availability.sales : path === "gno.land/r/samcrew/tokenfactory_v2" ? availability.factory : false,
}))

const session = (key: string, address?: string) => ({ network: { key }, status: address ? "member" : "guest", address }) as never
const fallback = <p>classic token page</p>
const props = (key: string, address?: string) => ({ session: session(key, address), fallback, section: null }) as never

describe("Tokens window", () => {
    beforeEach(() => {
        availability.factory = false
        availability.launchpad = false
        availability.sales = false
        listPage.mockReset()
        launch.mockReset()
        fairBuyer.mockReset()
        vesting.mockReset()
    })

    it("explains the missing mainnet factory without exposing the classic token actions", () => {
        render(<TokensWindow {...props("mainnet")} />)
        expect(screen.getByRole("note")).toHaveTextContent("screens are implemented")
        expect(screen.getByRole("note")).toHaveTextContent("factory is not deployed")
        expect(screen.queryByText("classic token page")).toBeNull()
    })

    it("uses a neutral unavailable state for another network", () => {
        render(<TokensWindow {...props("test13")} />)
        expect(screen.getByRole("note")).toHaveTextContent("factory is not available")
    })

    it("preserves the existing classic page where the factory is available", () => {
        availability.factory = true
        render(<TokensWindow {...props("test13")} />)
        expect(screen.getByText("classic token page")).toBeInTheDocument()
        expect(screen.queryByRole("note")).toBeNull()
    })

    it("shows an existing direct token's fair sale when both source realms are available", async () => {
        availability.launchpad = true
        availability.sales = true
        listPage.mockResolvedValue([{ id: "T1", name: "Example", ticker: "EX", mode: "direct_fixed", creator: "g1creator", totalSupply: 1000n, decimals: 6, currencyKey: "ugnot" }])
        launch.mockResolvedValue({ fairSale: { cancelled: false, settled: true, succeeded: true, totalLots: 5n, hardCapLots: 10n, closePrice: 8n, quoteCurrency: "ugnot", proceedsReleased: true }, curve: null, airdrop: null, vestingCount: 0 })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText(/5 of 10 lots filled/)).toBeInTheDocument()
        expect(screen.getByText("0.001 EX")).toBeInTheDocument()
        expect(screen.getByText(/8 base units of ugnot per lot/)).toBeInTheDocument()
        expect(screen.queryByText("classic token page")).toBeNull()
        expect(listPage).toHaveBeenCalledWith(0, 20)
        expect(launch).toHaveBeenCalledWith("T1")
    })

    it("shows tokens without claiming sale availability when only the token realm is enabled", async () => {
        availability.launchpad = true
        listPage.mockResolvedValue([])
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        expect(await screen.findByText("No tokens on this page.")).toBeInTheDocument()
        expect(launch).not.toHaveBeenCalled()
    })

    it("retains the existing factory when both token paths are enabled", async () => {
        availability.launchpad = true
        availability.factory = true
        listPage.mockResolvedValue([])
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: "Open existing token factory" }))
        expect(screen.getByText("classic token page")).toBeInTheDocument()
    })

    it("separates each member's personal fair claim after an address switch", async () => {
        availability.launchpad = true
        availability.sales = true
        listPage.mockResolvedValue([{ id: "T1", name: "Example", ticker: "EX", mode: "direct_fixed", creator: "g1creator", totalSupply: 1000000n, decimals: 6, currencyKey: "ugnot" }])
        launch.mockResolvedValue({ fairSale: { cancelled: false, settled: true, succeeded: true, totalLots: 5n, hardCapLots: 10n, closePrice: 8n, quoteCurrency: "ugnot", proceedsReleased: false }, curve: null, airdrop: null, vestingCount: 0 })
        fairBuyer.mockImplementation(async (_id: string, address: string) => ({ claimableTokens: address === "first" ? 1000000n : 2000000n, claimableRefund: 3n, claimed: false }))
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "first")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText(/Your claim: 1 EX/)).toBeInTheDocument()
        view.rerender(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "second")} /></QueryClientProvider>)
        expect(await screen.findByText(/Your claim: 2 EX/)).toBeInTheDocument()
        expect(screen.queryByText(/Your claim: 1 EX/)).toBeNull()
        expect(fairBuyer).toHaveBeenCalledWith("T1", "second")
    })

    it("offers retry when the token read fails", async () => {
        availability.launchpad = true
        listPage.mockRejectedValueOnce(new Error("RPC unavailable")).mockResolvedValueOnce([])
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
        expect(await screen.findByText("No tokens on this page.")).toBeInTheDocument()
    })
})
