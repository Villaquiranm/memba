import type { Game } from "../../lib/connect4"
import { COLS, ROWS, cell, columnFull, winLine } from "./rules"
import "./connect4.css"

export function Board({ game, canPlay, onPlay }: { game: Game; canPlay: boolean; onPlay: (column: number) => void }) {
    const win = new Set(winLine(game.board).map(([c, r]) => `${c}:${r}`))
    return <div className="c4-board" role="group" aria-label="Connect 4 board">
        {Array.from({ length: COLS }, (_, c) => (
            <button key={c} type="button" className="c4-col" aria-label={`Drop in column ${c + 1}`}
                disabled={!canPlay || columnFull(game.board, c)} onClick={() => onPlay(c + 1)}>
                {Array.from({ length: ROWS }, (_, i) => {
                    const r = ROWS - 1 - i
                    const p = cell(game.board, c, r)
                    const last = game.moves > 0 && game.lastCol === c && game.lastRow === r
                    return <span key={r} className={`c4-cell c4-p${p}${last ? " c4-last" : ""}${win.has(`${c}:${r}`) ? " c4-win" : ""}`} />
                })}
            </button>
        ))}
    </div>
}
