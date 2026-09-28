package service

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const curationInboxPageSize = 30
const curationMessageMaxBytes = 4000

var curationClientID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type CurationInboxConfig struct {
	RPCURL    string
	ChainID   string
	Key       []byte // dedicated 32-byte key, never the auth signing seed
	AllowSend func(wallet string) bool
}

type curationMessage struct {
	ID        string `json:"id"`
	Sender    string `json:"sender"`
	Revision  int64  `json:"revision"`
	CreatedAt int64  `json:"createdAt"` // Unix microseconds
	Text      string `json:"text"`
}

type curationThreadPage struct {
	ChainID    string            `json:"chainId"`
	Collection string            `json:"collection"`
	Messages   []curationMessage `json:"messages"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

type curationPageCursor struct {
	ChainID    string `json:"chain"`
	Collection string `json:"collection"`
	CreatedAt  int64  `json:"createdAt"`
	ID         string `json:"id"`
}

type curationSendRequest struct {
	ClientID string `json:"clientId"`
	Text     string `json:"text"`
}

type curationInbox struct {
	db   *sql.DB
	cfg  CurationInboxConfig
	aead cipher.AEAD
}

// NewCurationInboxHandler provides a text-only, encrypted founder/manager
// thread. It must be wrapped by exact-chain wallet authentication and remains
// disabled unless a dedicated encryption key and the on-chain curation realm
// are deliberately configured. Every request rechecks current chain access.
func NewCurationInboxHandler(db *sql.DB, cfg CurationInboxConfig) (http.Handler, error) {
	if db == nil || cfg.RPCURL == "" || cfg.ChainID == "" || len(cfg.Key) != 32 || cfg.AllowSend == nil {
		return nil, errors.New("curation inbox requires database, chain, RPC, key and send limiter")
	}
	block, err := aes.NewCipher(cfg.Key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	inbox := &curationInbox{db: db, cfg: cfg, aead: aead}
	return http.HandlerFunc(inbox.serveHTTP), nil
}

func (i *curationInbox) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeHoldingsError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	wallet, ok := AuthAddressFrom(r.Context())
	if !ok {
		writeHoldingsError(w, http.StatusUnauthorized, "wallet authentication required")
		return
	}
	collection := r.URL.Query().Get("collection")
	if !launchpadCollectionID.MatchString(collection) {
		writeHoldingsError(w, http.StatusBadRequest, "invalid collection")
		return
	}
	if r.Method == http.MethodPost && !i.cfg.AllowSend(wallet) {
		writeHoldingsError(w, http.StatusTooManyRequests, "message rate limit exceeded")
		return
	}
	access, err := readLaunchpadReviewAccess(r.Context(), i.cfg.RPCURL, i.cfg.ChainID, collection, wallet)
	if err != nil {
		slog.Warn("curation inbox access unavailable", "error", err)
		writeHoldingsError(w, http.StatusServiceUnavailable, "curation inbox unavailable")
		return
	}
	if access == nil || !access.CanRead {
		writeHoldingsError(w, http.StatusForbidden, "curation thread unavailable")
		return
	}
	if r.Method == http.MethodGet {
		i.readThread(w, r, collection, wallet)
		return
	}
	i.sendMessage(w, r, collection, wallet, access.Revision)
}

func (i *curationInbox) readThread(w http.ResponseWriter, r *http.Request, collection, wallet string) {
	cursor, err := decodeCurationCursor(r.URL.Query().Get("cursor"))
	if err != nil || (cursor != nil && (cursor.ChainID != i.cfg.ChainID || cursor.Collection != collection)) {
		writeHoldingsError(w, http.StatusBadRequest, "invalid thread cursor")
		return
	}
	afterTime, afterID := int64(0), ""
	if cursor != nil {
		afterTime, afterID = cursor.CreatedAt, cursor.ID
	}
	rows, err := i.db.QueryContext(r.Context(), `SELECT id, sender, revision, created_at, nonce, ciphertext
		FROM launchpad_curation_messages WHERE chain_id=? AND collection=?
		  AND (?=0 OR created_at<? OR (created_at=? AND id<?))
		ORDER BY created_at DESC, id DESC LIMIT ?`,
		i.cfg.ChainID, collection, afterTime, afterTime, afterTime, afterID, curationInboxPageSize+1)
	if err != nil {
		i.unavailable(w, err)
		return
	}
	messages := make([]curationMessage, 0, curationInboxPageSize+1)
	for rows.Next() {
		var m curationMessage
		var nonce, ciphertext []byte
		if err := rows.Scan(&m.ID, &m.Sender, &m.Revision, &m.CreatedAt, &nonce, &ciphertext); err != nil {
			_ = rows.Close()
			i.unavailable(w, err)
			return
		}
		plain, err := i.aead.Open(nil, nonce, ciphertext, curationAAD(i.cfg.ChainID, collection, m))
		if err != nil || !utf8.Valid(plain) {
			_ = rows.Close()
			i.unavailable(w, errors.New("curation message integrity check failed"))
			return
		}
		m.Text = string(plain)
		messages = append(messages, m)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		i.unavailable(w, err)
		return
	}
	_ = rows.Close()
	page := curationThreadPage{ChainID: i.cfg.ChainID, Collection: collection, Messages: messages}
	if len(messages) > curationInboxPageSize {
		page.Messages = messages[:curationInboxPageSize]
		last := page.Messages[len(page.Messages)-1]
		page.NextCursor = encodeCurationCursor(curationPageCursor{i.cfg.ChainID, collection, last.CreatedAt, last.ID})
	}
	if _, err := i.db.ExecContext(r.Context(), `INSERT INTO launchpad_curation_message_audit
		(chain_id, collection, actor, action, created_at) VALUES (?, ?, ?, 'read', ?)`,
		i.cfg.ChainID, collection, wallet, time.Now().UnixMicro()); err != nil {
		i.unavailable(w, err)
		return
	}
	_ = json.NewEncoder(w).Encode(page)
}

func (i *curationInbox) sendMessage(w http.ResponseWriter, r *http.Request, collection, wallet, revisionRaw string) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeHoldingsError(w, http.StatusUnsupportedMediaType, "JSON required")
		return
	}
	var input curationSendRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF {
		writeHoldingsError(w, http.StatusBadRequest, "invalid message")
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if !curationClientID.MatchString(input.ClientID) || input.Text == "" ||
		len(input.Text) > curationMessageMaxBytes || !utf8.ValidString(input.Text) || strings.ContainsRune(input.Text, 0) {
		writeHoldingsError(w, http.StatusBadRequest, "invalid message")
		return
	}
	revision, err := strconv.ParseInt(revisionRaw, 10, 64)
	if err != nil || revision < 1 {
		i.unavailable(w, errors.New("invalid chain application revision"))
		return
	}
	var idBytes [16]byte
	nonce := make([]byte, i.aead.NonceSize())
	if _, err := rand.Read(idBytes[:]); err != nil {
		i.unavailable(w, err)
		return
	}
	if _, err := rand.Read(nonce); err != nil {
		i.unavailable(w, err)
		return
	}
	m := curationMessage{ID: hex.EncodeToString(idBytes[:]), Sender: wallet, Revision: revision,
		CreatedAt: time.Now().UnixMicro(), Text: input.Text}
	ciphertext := i.aead.Seal(nil, nonce, []byte(m.Text), curationAAD(i.cfg.ChainID, collection, m))
	tx, err := i.db.BeginTx(r.Context(), nil)
	if err != nil {
		i.unavailable(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(r.Context(), `INSERT INTO launchpad_curation_messages
		(id, chain_id, collection, revision, sender, client_id, created_at, nonce, ciphertext)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(chain_id, sender, client_id) DO NOTHING`,
		m.ID, i.cfg.ChainID, collection, revision, wallet, input.ClientID, m.CreatedAt, nonce, ciphertext)
	if err != nil {
		i.unavailable(w, err)
		return
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		i.unavailable(w, err)
		return
	}
	if inserted == 0 {
		_ = tx.Rollback()
		old, same, err := i.readIdempotentMessage(r.Context(), wallet, collection, input)
		if err != nil {
			i.unavailable(w, err)
			return
		}
		if !same {
			writeHoldingsError(w, http.StatusConflict, "message id reused with different content")
			return
		}
		_ = json.NewEncoder(w).Encode(old)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO launchpad_curation_message_audit
		(chain_id, collection, actor, action, created_at) VALUES (?, ?, ?, 'send', ?)`,
		i.cfg.ChainID, collection, wallet, m.CreatedAt); err != nil {
		i.unavailable(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		i.unavailable(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(m)
}

func (i *curationInbox) readIdempotentMessage(ctx context.Context, wallet, collection string, input curationSendRequest) (curationMessage, bool, error) {
	var m curationMessage
	var storedCollection string
	var nonce, ciphertext []byte
	err := i.db.QueryRowContext(ctx, `SELECT id, collection, sender, revision, created_at, nonce, ciphertext
		FROM launchpad_curation_messages WHERE chain_id=? AND sender=? AND client_id=?`,
		i.cfg.ChainID, wallet, input.ClientID).Scan(&m.ID, &storedCollection, &m.Sender, &m.Revision, &m.CreatedAt, &nonce, &ciphertext)
	if err != nil {
		return m, false, err
	}
	if storedCollection != collection {
		return m, false, nil
	}
	plain, err := i.aead.Open(nil, nonce, ciphertext, curationAAD(i.cfg.ChainID, collection, m))
	if err != nil {
		return m, false, err
	}
	m.Text = string(plain)
	return m, m.Text == input.Text, nil
}

func curationAAD(chainID, collection string, m curationMessage) []byte {
	return []byte(fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%d\x00%d", chainID, collection, m.ID, m.Sender, m.Revision, m.CreatedAt))
}

func encodeCurationCursor(cursor curationPageCursor) string {
	raw, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCurationCursor(raw string) (*curationPageCursor, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 512 {
		return nil, errors.New("cursor too long")
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	var cursor curationPageCursor
	if err := json.Unmarshal(data, &cursor); err != nil || !curationClientID.MatchString(cursor.ID) || cursor.CreatedAt < 1 {
		return nil, errors.New("invalid cursor")
	}
	return &cursor, nil
}

func (i *curationInbox) unavailable(w http.ResponseWriter, err error) {
	slog.Warn("curation inbox unavailable", "error", err)
	writeHoldingsError(w, http.StatusServiceUnavailable, "curation inbox unavailable")
}
