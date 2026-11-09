interface Format { version: number; blockSize: number; codec: string }
interface StorageStatus {
  ready: boolean
  generation: string | null
  requested: Format | null
  maintenance: { converted: number } | null
  databaseSize: number
}

export async function prepareStorage(send: (route: string, init?: RequestInit) => Promise<Response>, report: (status: StorageStatus) => void = () => {}) {
  async function read(route: string, init?: RequestInit): Promise<StorageStatus> {
    const response = await send(route, init)
    if (!response.ok) throw new Error(`storage maintenance refused: ${response.status} ${await response.text()}`)
    const status = await response.json() as StorageStatus
    if (typeof status.ready !== 'boolean' || !Number.isSafeInteger(status.databaseSize) || status.databaseSize < 0) {
      throw new Error('invalid storage maintenance status')
    }
    return status
  }
  let status = await read('storage')
  if (status.ready) return
  const { generation, requested } = status
  if (!generation || requested?.version !== 1 || requested.blockSize !== 8192 || requested.codec !== 'deflate') {
    throw new Error('storage maintenance requires a complete generation and an explicit 8 KiB deflate target')
  }
  while (!status.ready) {
    const converted = status.maintenance?.converted ?? 0
    status = await read('compress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation, target: requested }) })
    if (status.generation !== generation || status.requested?.version !== requested.version ||
        status.requested.blockSize !== requested.blockSize || status.requested.codec !== requested.codec) {
      throw new Error('storage maintenance identity changed')
    }
    if (!status.ready && (!Number.isSafeInteger(status.maintenance?.converted) || status.maintenance!.converted <= converted)) {
      throw new Error('storage maintenance made no progress')
    }
    report(status)
  }
}
