import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { packageAddress } from "../../../lib/dao/weightedApplications"
import ManageLaunchpadToken from "./manage"

const readState = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadNftControl", async (original) => ({
    ...(await original<typeof import("../../../lib/launchpadNftControl")>()), readNftControlState: readState,
}))
vi.mock("../../../lib/grc20", async (original) => ({
    ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })),
}))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const holder = packageAddress("gno.land/r/samcrew/person/holder")
const recipient = packageAddress("gno.land/r/samcrew/person/recipient")
const creator = packageAddress("gno.land/r/samcrew/person/creator")
const session = { status: "member", address: holder, network: { key: "testnet12", chainId: "test12" }, openConnect: vi.fn() } as never
const open = { collection: { id: "C1", name: "Civic Art", creator, mode: "open", revocable: false, minted: 2n },
    token: { collection: "C1", number: 2n, owner: holder, status: "active", soulbound: false, uri: "ipfs://art/2.json" } }

describe("native NFT token management", () => {
    beforeEach(() => { readState.mockReset(); sign.mockReset(); localStorage.clear() })

    it("gates an unpublished NFT ledger", () => {
        render(<ManageLaunchpadToken rpcUrl="rpc" session={session} available={false} toast={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaits the reviewed NFT ledger")
        expect(readState).not.toHaveBeenCalled()
    })

    it("reads owner and reviews one Open direct transfer", async () => {
        readState.mockResolvedValue(open)
        render(<ManageLaunchpadToken rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.change(screen.getByLabelText("Token number"), { target: { value: "2" } })
        fireEvent.click(screen.getByRole("button", { name: "Check token rights" }))
        expect(await screen.findByText(/Civic Art · C1 #2/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Recipient wallet"), { target: { value: recipient } })
        fireEvent.click(screen.getByRole("button", { name: "Review direct transfer" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0].value).toMatchObject({
            caller: holder, send: "", func: "Transfer", args: ["C1", holder, recipient, "2"],
        })
    })

    it("offers holder burn and issuer revoke but no transfer for Soulbound tokens", async () => {
        readState.mockResolvedValue({ collection: { ...open.collection, creator: holder, mode: "soulbound", revocable: true },
            token: { ...open.token, soulbound: true } })
        render(<ManageLaunchpadToken rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.change(screen.getByLabelText("Token number"), { target: { value: "2" } })
        fireEvent.click(screen.getByRole("button", { name: "Check token rights" }))
        expect(await screen.findByText("Status: active · Soulbound")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review direct transfer" })).toBeNull()
        expect(screen.getByRole("button", { name: "Review permanent burn" })).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Public revocation reason"), { target: { value: "issuer_error" } })
        fireEvent.click(screen.getByRole("button", { name: "Review issuer revocation" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0].value).toMatchObject({
            caller: holder, send: "", func: "Revoke", args: ["C1", "2", "issuer_error"],
        })
    })
})
