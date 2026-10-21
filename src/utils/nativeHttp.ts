/**
 * Headers for a CapacitorHttp request. Adds `Connection: close` so the native
 * HttpURLConnection never returns the socket to its keep-alive pool.
 *
 * The pool keeps idle connections for 5 minutes, but the network path can drop
 * an idle TCP connection silently well before that (no FIN/RST). The first calls
 * after a pause between turns then reuse a dead socket: the request is written,
 * never ACKed, and waits out the read timeout — seen on device as nano-gpt
 * sockets stuck retransmitting with KBs unacked while utility calls hung for
 * their full deadline. The pool's lifetime can't be shortened from the app:
 * Android reads `http.keepAliveDuration` in the zygote, before app code runs.
 * A fresh TLS handshake per call costs a fraction of a second.
 */
export function noKeepAlive(headers: Record<string, string>): Record<string, string> {
    return { ...headers, Connection: 'close' };
}
