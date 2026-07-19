const { Transform } = require("stream");

// A passthrough stream that reports cumulative bytes seen so far via
// onBytes(bytesSoFar). Works uniformly for both upload (wrap the read
// stream before handing it to the adapter) and download (wrap the write
// destination, piping the counter into the real destination) regardless
// of which protocol adapter (FTP/SFTP) is moving the bytes — the adapters
// just see an ordinary stream.
function countingStream(onBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      seen += chunk.length;
      try {
        onBytes(seen);
      } catch (e) {
        /* progress reporting must never break the transfer */
      }
      cb(null, chunk);
    },
  });
}

module.exports = { countingStream };
