import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkAddress } from '../shared/types'

const VIRTUAL_IFACE = /(utun|tun|tap|docker|bridge|veth|virbr|vmnet|vboxnet|zt|tailscale|wg)/i

function isPrivate(address: string): boolean {
  if (address.startsWith('10.')) return true
  if (address.startsWith('192.168.')) return true
  const match = address.match(/^172\.(\d+)\./)
  if (match) {
    const second = Number(match[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

export function listAddresses(): NetworkAddress[] {
  const entries: NetworkAddress[] = []
  const interfaces = networkInterfaces()
  for (const [iface, values] of Object.entries(interfaces)) {
    for (const value of values || []) {
      if (value.family !== 'IPv4' || value.internal) continue
      entries.push({ address: value.address, iface, preferred: false })
    }
  }
  entries.sort((left, right) => {
    const leftVirtual = VIRTUAL_IFACE.test(left.iface) ? 1 : 0
    const rightVirtual = VIRTUAL_IFACE.test(right.iface) ? 1 : 0
    if (leftVirtual !== rightVirtual) return leftVirtual - rightVirtual
    const leftPrivate = isPrivate(left.address) ? 0 : 1
    const rightPrivate = isPrivate(right.address) ? 0 : 1
    if (leftPrivate !== rightPrivate) return leftPrivate - rightPrivate
    return left.address.localeCompare(right.address)
  })
  if (entries.length > 0) entries[0].preferred = true
  return entries
}

export function preferredAddress(): string {
  return listAddresses()[0]?.address || '127.0.0.1'
}

export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, host)
  })
}

export async function findFreePort(start: number, limit = 20): Promise<number> {
  for (let offset = 0; offset < limit; offset += 1) {
    const port = start + offset
    if (port > 65535) break
    if (await isPortFree(port)) return port
  }
  return 0
}
