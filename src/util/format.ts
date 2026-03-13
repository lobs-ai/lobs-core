/**
 * Formats a byte count into a human-readable string.
 * 
 * @param bytes - The number of bytes to format
 * @param decimals - Number of decimal places to show (default: 1)
 * @returns Formatted string with appropriate unit (B, KB, MB, GB, TB, PB)
 * 
 * @example
 * formatBytes(1024) // "1.0 KB"
 * formatBytes(1536, 2) // "1.50 KB"
 * formatBytes(1048576) // "1.0 MB"
 * formatBytes(0) // "0 B"
 */
export function formatBytes(bytes: number, decimals: number = 1): string {
  if (bytes === 0) return '0 B';
  
  if (bytes < 0) {
    throw new Error('formatBytes: bytes cannot be negative');
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  // Clamp to available units
  const unitIndex = Math.min(i, sizes.length - 1);
  
  const value = bytes / Math.pow(k, unitIndex);
  
  return `${value.toFixed(dm)} ${sizes[unitIndex]}`;
}
