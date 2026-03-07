import { NextResponse } from 'next/server'
import { getCliAuthStatus, getCliAvailability } from '@/lib/claude-cli-auth'

export async function GET(): Promise<NextResponse> {
  const oauthStatus = getCliAuthStatus()

  // Only check CLI subprocess availability if OAuth credentials exist
  // (avoids unnecessary subprocess spawn when CLI isn't installed)
  const cliDirectAvailable = oauthStatus.available && !oauthStatus.expired
    ? await getCliAvailability()
    : false

  return NextResponse.json({
    ...oauthStatus,
    cliDirectAvailable,
    mode: cliDirectAvailable ? 'cli' : oauthStatus.available ? 'oauth' : 'api-key',
  })
}
