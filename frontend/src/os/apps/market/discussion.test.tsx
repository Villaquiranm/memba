import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import CurationDiscussion from "./discussion"

const readAccess = vi.hoisted(() => vi.fn())
const readThread = vi.hoisted(() => vi.fn())
const sendMessage = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadCurationInbox", async (original) => ({
    ...(await original<typeof import("../../../lib/launchpadCurationInbox")>()),
    readCurationAccess: readAccess, readCurationThread: readThread, sendCurationMessage: sendMessage,
}))

const account = `g1${"q".repeat(38)}`
const founder = `g1${"p".repeat(38)}`
const props = { collection: "C1", account, chainId: "gnoland-1",
    token: { userAddress: account, chainId: "gnoland-1" } as never }
const access = { collection: "C1", account, founder, revision: "1", status: "submitted",
    isFounder: false, isManager: true, canRead: true, canReview: true }
const message = { id: "a".repeat(32), sender: founder, revision: 1, createdAt: 1700000000000000, text: "Private launch plan" }

describe("native founder discussion", () => {
    beforeEach(() => {
        readAccess.mockReset().mockResolvedValue(access)
        readThread.mockReset().mockResolvedValue({ chainId: "gnoland-1", collection: "C1", messages: [message], nextCursor: "" })
        sendMessage.mockReset().mockResolvedValue({ ...message, sender: account, text: "I can review" })
    })

    it("shows messages only after live access and can send text", async () => {
        let releaseAccess!: (value: typeof access) => void
        readAccess.mockReturnValueOnce(new Promise((resolve) => { releaseAccess = resolve }))
        render(<CurationDiscussion {...props} />)
        expect(screen.queryByText("Private launch plan")).toBeNull()
        releaseAccess(access)
        expect(await screen.findByText("Private launch plan")).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Message"), { target: { value: "I can review" } })
        fireEvent.click(screen.getByRole("button", { name: "Send message" }))
        await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("C1", account, "gnoland-1", props.token, expect.stringMatching(/^[0-9a-f]{32}$/), "I can review"))
        await waitFor(() => expect(readAccess).toHaveBeenCalledTimes(2))
    })

    it("clears private content if a manager loses access on refresh", async () => {
        render(<CurationDiscussion {...props} />)
        expect(await screen.findByText("Private launch plan")).toBeInTheDocument()
        readAccess.mockRejectedValueOnce(new Error("This wallet cannot open this founder discussion."))
        fireEvent.click(screen.getByRole("button", { name: "Refresh discussion" }))
        await waitFor(() => expect(screen.queryByText("Private launch plan")).toBeNull())
        expect(await screen.findByRole("alert")).toHaveTextContent("cannot open")
    })
})
