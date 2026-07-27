import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Un tenant sans location primaire n'est pas un 404 client — c'est un incident de
 * provisioning côté backend (migrate-create-primary-locations.ts n'a pas tourné, ou la
 * primaire a été supprimée en base directement). Doit être diagnosticable immédiatement,
 * pas confondu avec une ressource absente ordinaire.
 */
export class TenantMisconfiguredException extends HttpException {
  constructor(tenantId: string, reason: string) {
    super(
      {
        code: 'TENANT_MISCONFIGURED',
        message: `Tenant ${tenantId} has no resolvable location: ${reason}`,
        tenantId,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
