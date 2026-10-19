/** Resolve when a child process exits with code 0; reject otherwise. */
export function runChild(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${child.spawnargs.join(' ')} exited with ${signal ?? `code ${code}`}`
          )
        );
      }
    });
  });
}
