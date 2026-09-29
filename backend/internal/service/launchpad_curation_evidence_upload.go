package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const curationEvidenceMaxBytes = 16 * 1024

var curationEvidenceCID = regexp.MustCompile(`^(bafy[a-z2-7]{55,86}|Qm[1-9A-HJ-NP-Za-km-z]{44})$`)

// HandleCurationEvidenceUpload pins small public plain-text evidence and returns
// both its content address and the SHA-256 of the exact bytes. It must be
// wrapped with exact-chain wallet authentication, a per-IP limit and a feature
// flag. The caller's per-wallet budget is checked before using the pinning key.
func HandleCurationEvidenceUpload(rpcURL, chainID string, allow func(string) bool, opts ...ipfsUploadOptions) http.Handler {
	var o ipfsUploadOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
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
		if rpcURL == "" || chainID == "" {
			writeHoldingsError(w, http.StatusServiceUnavailable, "public evidence upload unavailable")
			return
		}
		if allow == nil || !allow(wallet) {
			writeHoldingsError(w, http.StatusTooManyRequests, "public evidence upload limit exceeded")
			return
		}
		apiKey := os.Getenv("LIGHTHOUSE_API_KEY")
		if apiKey == "" {
			writeHoldingsError(w, http.StatusServiceUnavailable, "public evidence upload unavailable")
			return
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "text/plain" {
			writeHoldingsError(w, http.StatusUnsupportedMediaType, "plain text required")
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, curationEvidenceMaxBytes+1))
		if err != nil || len(data) > curationEvidenceMaxBytes {
			writeHoldingsError(w, http.StatusRequestEntityTooLarge, "public evidence too large")
			return
		}
		if len(data) == 0 || !utf8.Valid(data) || bytes.ContainsRune(data, 0) || strings.TrimSpace(string(data)) == "" {
			writeHoldingsError(w, http.StatusBadRequest, "readable public text required")
			return
		}
		access, err := readLaunchpadReviewAccess(r.Context(), rpcURL, chainID, collection, wallet)
		if err != nil {
			writeHoldingsError(w, http.StatusServiceUnavailable, "curation authority unavailable")
			return
		}
		if access == nil {
			editorial, err := readLaunchpadEditorialAccess(r.Context(), rpcURL, chainID, collection, wallet)
			if err != nil {
				writeHoldingsError(w, http.StatusServiceUnavailable, "collection authority unavailable")
				return
			}
			if editorial == nil || (editorial.Creator != wallet && !editorial.IsManager) {
				writeHoldingsError(w, http.StatusForbidden, "collection creator required")
				return
			}
		} else if !access.IsFounder && !access.IsManager {
			writeHoldingsError(w, http.StatusForbidden, "curation role required")
			return
		}
		digest := sha256.Sum256(data)
		var outbound bytes.Buffer
		mw := multipart.NewWriter(&outbound)
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="file"; filename="curation-evidence.txt"`)
		header.Set("Content-Type", "text/plain; charset=utf-8")
		part, err := mw.CreatePart(header)
		if err == nil {
			_, err = part.Write(data)
		}
		if err == nil {
			err = mw.Close()
		}
		if err != nil {
			writeHoldingsError(w, http.StatusServiceUnavailable, "public evidence upload unavailable")
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, o.resolvedURL(), &outbound)
		if err != nil {
			writeHoldingsError(w, http.StatusServiceUnavailable, "public evidence upload unavailable")
			return
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+apiKey)
		client := o.httpClient
		if client == nil {
			client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		}
		resp, err := client.Do(req)
		if err != nil {
			slog.Warn("curation evidence pin unavailable", "error", err)
			writeHoldingsError(w, http.StatusBadGateway, "public evidence pin unavailable")
			return
		}
		defer func() { _ = resp.Body.Close() }()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8193))
		if err != nil || len(body) > 8192 || resp.StatusCode != http.StatusOK {
			writeHoldingsError(w, http.StatusBadGateway, "public evidence pin unavailable")
			return
		}
		var pinned struct {
			Hash string `json:"Hash"`
			CID  string `json:"cid"`
		}
		if err := json.Unmarshal(body, &pinned); err != nil {
			writeHoldingsError(w, http.StatusBadGateway, "invalid pin response")
			return
		}
		cid := pinned.Hash
		if cid == "" {
			cid = pinned.CID
		}
		if !curationEvidenceCID.MatchString(cid) {
			writeHoldingsError(w, http.StatusBadGateway, "invalid pin response")
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"cid": cid, "sha256": hex.EncodeToString(digest[:])})
		slog.Info("public curation evidence pinned", "cid", cid, "bytes", len(data))
	})
}
