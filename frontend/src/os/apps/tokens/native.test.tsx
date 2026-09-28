import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TokensWindow from "./native"

const availability = vi.hoisted(() => ({ factory: false, launchpad: false, sales: false, pool: false }))
const listPage = vi.hoisted(() => vi.fn())
const balanceOf = vi.hoisted(() => vi.fn())
const launch = vi.hoisted(() => vi.fn())
const fairBuyer = vi.hoisted(() => vi.fn())
const vesting = vi.hoisted(() => vi.fn())
const pool = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/tokenLaunchpadClient", () => ({
    TOKEN_LAUNCHPAD_PATH: "gno.land/r/samcrew/launchpad/tokens/v1",
    TokenLaunchpadClient: class { listPage = listPage; balanceOf = balanceOf },
}))
vi.mock("../../../lib/tokenLaunchpadSalesClient", () => ({
    TOKEN_LAUNCHPAD_SALES_PATH: "gno.land/r/samcrew/launchpad/sales/v1",
    TokenLaunchpadSalesClient: class { launch = launch; fairBuyer = fairBuyer; vesting = vesting },
}))
vi.mock("../../../lib/tokenLaunchpadPoolClient", () => ({
    TOKEN_LAUNCHPAD_POOL_PATH: "gno.land/r/samcrew/launchpad/pool/v1",
    TokenLaunchpadPoolClient: class { pool = pool },
}))
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isRealmValidOn: (_network: string, path: string) => path === "gno.land/r/samcrew/launchpad/tokens/v1" ? availability.launchpad : path === "gno.land/r/samcrew/launchpad/sales/v1" ? availability.sales : path === "gno.land/r/samcrew/launchpad/pool/v1" ? availability.pool : path === "gno.land/r/samcrew/tokenfactory_v2" ? availability.factory : false,
}))

const session = (key: string, address?: string) => ({ network: { key }, status: address ? "member" : "guest", address }) as never
const fallback = <p>classic token page</p>
const props = (key: string, address?: string) => ({ session: session(key, address), fallback, section: null }) as never
const curveToken = () => ({ id: "T1", name: "Example", ticker: "EX", mode: "curve", creator: "g1creator", initialSupply: 1000000n, maxSupply: 1000000n, totalSupply: 1000000n, decimals: 6, currencyKey: "ugnot", configVersion: 3n, registryKey: "gno.land/r/samcrew/launchpad/tokens/v1.T1", grc20Id: "gno.land/r/samcrew/launchpad/tokens/v1.T1.0000001" })
const directToken = (supply = 1000000n) => ({ ...curveToken(), mode: "direct_fixed", initialSupply: supply, maxSupply: supply, totalSupply: supply })
const graduated = () => ({ token: curveToken(), curve: { status: "graduated", creator: "g1creator", quoteCurrency: "ugnot", configVersion: 3n, raised: 1000n, graduationTarget: 1000n, sold: 500000n }, fairSale: null, airdrop: null, vestingCount: 0 })
const fairLaunch = (token = directToken(), proceedsReleased = true) => ({ token, fairSale: { creator: "g1creator", configVersion: 3n, cancelled: false, settled: true, succeeded: true, totalLots: 5n, hardCapLots: 10n, closePrice: 8n, quoteCurrency: "ugnot", proceedsReleased }, curve: null, airdrop: null, vestingCount: 0 })

describe("Tokens window", () => {
    beforeEach(() => {
        availability.factory = false
        availability.launchpad = false
        availability.sales = false
        availability.pool = false
        listPage.mockReset()
        balanceOf.mockReset()
        balanceOf.mockResolvedValue(0n)
        launch.mockReset()
        fairBuyer.mockReset()
        vesting.mockReset()
        pool.mockReset()
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
        listPage.mockResolvedValue([directToken(1000n)])
        launch.mockResolvedValue(fairLaunch(directToken(1000n)))
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

    it("keeps a later fair sale on an existing direct token visible across currency and version changes", async () => {
        availability.launchpad = true
        availability.sales = true
        listPage.mockResolvedValue([directToken()])
        launch.mockResolvedValue({ ...fairLaunch(), fairSale: {
            ...fairLaunch().fairSale, quoteCurrency: "gno.land/r/gnoland/wugnot.wugnot", configVersion: 4n,
        } })
        fairBuyer.mockResolvedValue({ claimableTokens: 1000000n, claimableRefund: 2n, claimed: false })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "first")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText(/Your claim: 1 EX/)).toBeInTheDocument()
        expect(screen.getByText(/base units of gno.land\/r\/gnoland\/wugnot.wugnot per lot/)).toBeInTheDocument()
        expect(screen.queryByText("Sale identity does not match this token.")).toBeNull()
        expect(fairBuyer).toHaveBeenCalledWith("T1", "first")
    })

    it("shows tokens without claiming sale availability when only the token realm is enabled", async () => {
        availability.launchpad = true
        listPage.mockResolvedValue([])
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        expect(await screen.findByText("No tokens on this page.")).toBeInTheDocument()
        expect(launch).not.toHaveBeenCalled()
    })

    it("withholds sale state and personal claims when embedded token identity disagrees", async () => {
        availability.launchpad = true
        availability.sales = true
        listPage.mockResolvedValue([directToken()])
        launch.mockResolvedValue(fairLaunch({ ...directToken(), grc20Id: "another-ledger" }))
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "first")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText("Sale identity does not match this token.")).toBeInTheDocument()
        expect(screen.queryByText("Fair sale")).toBeNull()
        expect(screen.queryByText(/Your claim:/)).toBeNull()
        expect(fairBuyer).not.toHaveBeenCalled()
    })

    it("withholds sale state when campaign terms disagree with the listed token", async () => {
        availability.launchpad = true
        availability.sales = true
        listPage.mockResolvedValue([directToken()])
        launch.mockResolvedValue({ ...fairLaunch(), fairSale: { ...fairLaunch().fairSale, creator: "g1other" } })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Sale identity does not match")
        expect(screen.queryByText("Fair sale")).toBeNull()
    })

    it("shows exact locked-pool reserves only when its realm and launch identity match", async () => {
        availability.launchpad = true
        availability.sales = true
        availability.pool = true
        listPage.mockResolvedValue([curveToken()])
        launch.mockResolvedValue(graduated())
        pool.mockResolvedValue({ id: "T1", creator: "g1creator", quoteCurrency: "ugnot", configVersion: 3n, tokenReserve: 250000n, quoteReserve: 1002n })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText(/Recorded reserves: 0.25 EX and 1002 base units of ugnot/)).toBeInTheDocument()
        expect(screen.getByText(/These assets have no withdrawal claim/)).toBeInTheDocument()
        expect(pool).toHaveBeenCalledWith("T1")
    })

    it("does not present reserves from a mismatched pool identity", async () => {
        availability.launchpad = true
        availability.sales = true
        availability.pool = true
        listPage.mockResolvedValue([curveToken()])
        launch.mockResolvedValue(graduated())
        pool.mockResolvedValue({ id: "T1", creator: "g1other", quoteCurrency: "ugnot", configVersion: 3n, tokenReserve: 250000n, quoteReserve: 1002n })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Pool identity does not match")
        expect(screen.queryByText(/Recorded reserves:/)).toBeNull()
    })

    it("rejects pool reserves when the token list disagrees with the sale and pool", async () => {
        availability.launchpad = true
        availability.sales = true
        availability.pool = true
        listPage.mockResolvedValue([{ ...curveToken(), currencyKey: "other", configVersion: 4n }])
        launch.mockResolvedValue(graduated())
        pool.mockResolvedValue({ id: "T1", creator: "g1creator", quoteCurrency: "ugnot", configVersion: 3n, tokenReserve: 250000n, quoteReserve: 1002n })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Sale identity does not match")
        expect(pool).not.toHaveBeenCalled()
        expect(screen.queryByText(/Recorded reserves:/)).toBeNull()
    })

    it("refuses to format pool reserves with stale token decimals", async () => {
        availability.launchpad = true
        availability.sales = true
        availability.pool = true
        listPage.mockResolvedValue([{ ...curveToken(), decimals: 12 }])
        launch.mockResolvedValue(graduated())
        pool.mockResolvedValue({ id: "T1", creator: "g1creator", quoteCurrency: "ugnot", configVersion: 3n, tokenReserve: 250000n, quoteReserve: 1002n })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Sale identity does not match")
        expect(pool).not.toHaveBeenCalled()
        expect(screen.queryByText(/Recorded reserves:/)).toBeNull()
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
        listPage.mockResolvedValue([directToken()])
        launch.mockResolvedValue(fairLaunch(directToken(), false))
        fairBuyer.mockImplementation(async (_id: string, address: string) => ({ claimableTokens: address === "first" ? 1000000n : 2000000n, claimableRefund: 3n, claimed: false }))
        balanceOf.mockImplementation(async (_id: string, address: string) => address === "first" ? 2000000n : 3000000n)
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "first")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        expect(await screen.findByText(/Your claim: 1 EX/)).toBeInTheDocument()
        expect(await screen.findByText("Your balance: 2 EX.")).toBeInTheDocument()
        expect(screen.getByText("gno.land/r/samcrew/launchpad/tokens/v1.T1")).toBeInTheDocument()
        view.rerender(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "second")} /></QueryClientProvider>)
        expect(await screen.findByText(/Your claim: 2 EX/)).toBeInTheDocument()
        expect(await screen.findByText("Your balance: 3 EX.")).toBeInTheDocument()
        expect(screen.queryByText(/Your claim: 1 EX/)).toBeNull()
        expect(screen.queryByText("Your balance: 2 EX.")).toBeNull()
        expect(fairBuyer).toHaveBeenCalledWith("T1", "second")
        expect(balanceOf).toHaveBeenCalledWith("T1", "second")
    })

    it("offers retry when the token read fails", async () => {
        availability.launchpad = true
        listPage.mockRejectedValueOnce(new Error("RPC unavailable")).mockResolvedValueOnce([])
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
        expect(await screen.findByText("No tokens on this page.")).toBeInTheDocument()
    })

    it("keeps a failed personal balance distinct from public token details", async () => {
        availability.launchpad = true
        listPage.mockResolvedValue([{ id: "T1", name: "Example", ticker: "EX", mode: "direct_fixed", creator: "g1creator", totalSupply: 1000000n, decimals: 6, currencyKey: "ugnot", registryKey: "gno.land/r/samcrew/launchpad/tokens/v1.T1", grc20Id: "gno.land/r/samcrew/launchpad/tokens/v1.T1.0000001" }])
        balanceOf.mockRejectedValueOnce(new Error("RPC unavailable")).mockResolvedValueOnce(1000000n)
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><TokensWindow {...props("mainnet", "first")} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole("button", { name: /Example EX/ }))
        fireEvent.click(await screen.findByRole("button", { name: "Retry balance" }))
        expect(await screen.findByText("Your balance: 1 EX.")).toBeInTheDocument()
        expect(screen.getByRole("region", { name: "Example details" })).toBeInTheDocument()
    })
})
