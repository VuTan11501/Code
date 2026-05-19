// biometric.js — Face ID / Touch ID / Windows Hello auto-unlock via WebAuthn.
//
// Strategy:
//   - Tier 1 (PRF):  Use WebAuthn PRF extension to derive a deterministic
//                    32-byte secret bound to the platform authenticator. Use
//                    that to AES-GCM unwrap the PAT. Crypto-bound to biometric.
//                    Supported: iOS 18+, Chrome 119+, recent macOS.
//   - Tier 2 (gate): If PRF unavailable, store an AES key alongside the
//                    encrypted PAT but only release it AFTER a successful
//                    navigator.credentials.get() with userVerification=required.
//                    The biometric ceremony is a UI gate, not a crypto bind.
//                    Acceptable for personal-device PWAs; equivalent risk to a
//                    rooted attacker dumping localStorage either way.
//
// Storage (single localStorage entry 'wf_dash_biometric'):
//   {
//     v: 2,
//     tier: 'prf' | 'gate',
//     credentialId: base64url,
//     // when tier=prf: salt for HKDF, then ciphertext (PAT) with iv/salt header
//     // when tier=gate: { key: base64 random AES key, ciphertext: ... }
//     payload: { ... }
//   }

window.Biometric = (function () {
  const STORE_KEY = 'wf_dash_biometric';
  const RP_NAME  = 'FJP Workflow Dashboard';

  // ---------- support detection ----------
  function isWebAuthnSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials);
  }

  // Biometric only makes sense in an installed PWA (home-screen app). In a
  // browser tab the user can already paste credentials anywhere, and on iOS
  // Safari WebAuthn assertions outside standalone mode have flaky UX.
  function isPwa() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
      if (navigator.standalone === true) return true; // iOS Safari
    } catch {}
    return false;
  }

  async function isPlatformAuthenticatorAvailable() {
    if (!isWebAuthnSupported()) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch { return false; }
  }

  function isEnabled() {
    try { return !!JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch { return false; }
  }

  function getStored() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch { return null; }
  }

  // ---------- base64url helpers ----------
  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBuf(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // ---------- AES-GCM with raw 32-byte key ----------
  async function importAesKey(rawBytes) {
    return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function aesEncrypt(plaintext, keyBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await importAesKey(keyBytes);
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(ct), 12);
    return bufToB64(out.buffer);
  }
  async function aesDecrypt(b64, keyBytes) {
    const combined = new Uint8Array(b64ToBuf(b64));
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const key = await importAesKey(keyBytes);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  // ---------- WebAuthn ceremonies ----------
  async function _createCredential(prfSalt) {
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const opts = {
      publicKey: {
        rp: { name: RP_NAME, id: window.location.hostname },
        user: { id: userId, name: 'dashboard@local', displayName: 'Dashboard User' },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
        },
        timeout: 60000,
        attestation: 'none',
        extensions: prfSalt ? { prf: { eval: { first: prfSalt } } } : {},
      },
    };
    return navigator.credentials.create(opts);
  }

  async function _assertCredential(credentialId, prfSalt) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const opts = {
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: b64urlToBuf(credentialId) }],
        userVerification: 'required',
        timeout: 60000,
        extensions: prfSalt ? { prf: { eval: { first: prfSalt } } } : {},
      },
    };
    return navigator.credentials.get(opts);
  }

  // ---------- public API: enroll ----------
  async function enroll(pat) {
    if (!await isPlatformAuthenticatorAvailable()) {
      throw new Error('Platform authenticator (Face ID / Touch ID / Windows Hello) not available on this device.');
    }
    if (!pat) throw new Error('PAT required for enrollment');

    // Try PRF first
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    let cred;
    try {
      cred = await _createCredential(prfSalt);
    } catch (e) {
      throw new Error('Biometric registration cancelled or failed: ' + (e.message || e));
    }
    const credentialId = bufToB64url(cred.rawId);

    // Check if PRF actually returned a key during registration (some
    // authenticators return PRF only on assertion). Do an immediate assertion
    // to test PRF availability and capture the key.
    let prfKey = null;
    try {
      const assert = await _assertCredential(credentialId, prfSalt);
      const extResults = assert.getClientExtensionResults();
      if (extResults?.prf?.results?.first) {
        prfKey = new Uint8Array(extResults.prf.results.first);
      }
    } catch (e) {
      console.warn('[Biometric] PRF probe assertion failed:', e);
    }

    if (prfKey && prfKey.length >= 32) {
      // Tier 1: encrypt PAT with PRF-derived key
      const ciphertext = await aesEncrypt(pat, prfKey.slice(0, 32));
      const record = {
        v: 2, tier: 'prf', credentialId,
        payload: { prfSalt: bufToB64(prfSalt.buffer), ciphertext },
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(record));
      return { ok: true, tier: 'prf' };
    }

    // Tier 2: random AES key stored locally; release gated by Face ID assertion
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const ciphertext = await aesEncrypt(pat, keyBytes);
    const record = {
      v: 2, tier: 'gate', credentialId,
      payload: { key: bufToB64(keyBytes.buffer), ciphertext },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(record));
    return { ok: true, tier: 'gate' };
  }

  // ---------- public API: unlock ----------
  async function unlock() {
    const rec = getStored();
    if (!rec) throw new Error('Biometric not enrolled on this device');
    if (rec.tier === 'prf') {
      const prfSalt = new Uint8Array(b64ToBuf(rec.payload.prfSalt));
      const assert = await _assertCredential(rec.credentialId, prfSalt);
      const extResults = assert.getClientExtensionResults();
      const prfRaw = extResults?.prf?.results?.first;
      if (!prfRaw) throw new Error('PRF result missing — authenticator may not support PRF anymore');
      const prfKey = new Uint8Array(prfRaw).slice(0, 32);
      return aesDecrypt(rec.payload.ciphertext, prfKey);
    } else {
      // Gate: require successful assertion first, then decrypt with stored key
      await _assertCredential(rec.credentialId, null);
      const keyBytes = new Uint8Array(b64ToBuf(rec.payload.key));
      return aesDecrypt(rec.payload.ciphertext, keyBytes);
    }
  }

  function disable() {
    localStorage.removeItem(STORE_KEY);
  }

  function tier() {
    const r = getStored();
    return r ? r.tier : null;
  }

  return {
    isWebAuthnSupported,
    isPwa,
    isPlatformAuthenticatorAvailable,
    isEnabled,
    enroll,
    unlock,
    disable,
    tier,
  };
})();
