import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../../src/db/client.js';
import { migrations } from '../../src/db/migrations.js';
import { collectMappingValidationIssues, MappingExistsError, MappingInputError, MappingNotFoundError, MappingNotValidatedError, MappingProductNotFoundError, MappingValidationError, MappingVersionConflictError, type MappingValidationIssue } from '../../src/modules/catalog/supplier-mapping.js';
import { createSupplierMappingRepository, type SaveMappingDraftInput, type SupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../../src/modules/orders/benefit-orders.js';
import { TestServer } from '../helpers/test-server.js';
import { columnsOf, countRows, seedProduct } from '../helpers/api-fixtures.js';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});
function draftInput(productId: string): SaveMappingDraftInput {
  return {
    productId,
    provider: 'yangmao',
    productCode: 'YM-1001',
    fulfillmentMode: 'B',
    deductionUnit: 'pack',
  };
}

function captureValidationError(run: () => unknown): MappingValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof MappingValidationError) return error;
    throw error;
  }
  throw new Error('Expected MappingValidationError');
}

describe('supplier mapping draft persistence', () => {
  it('persists one draft, keeps it readable after reopen, and exposes it by product', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    const draft = repository.saveDraft(draftInput(product.id));
    expect(draft).toMatchObject({
      productId: product.id,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
      version: 1,
      validatedVersion: null,
      validatedAt: null,
      activeVersionId: null,
    });
    expect(draft.mappingId).not.toBe(product.id);
    expect(draft.createdAt).toBe(draft.updatedAt);

    // The draft really lives in the SQLite file, not only in this process.
    const stored = server.database.sqlite
      .prepare(
        `SELECT product_id, provider, product_code, fulfillment_mode, deduction_unit,
                version, validated_version, validated_at, active_version_id
           FROM supplier_product_mappings WHERE id = ?`,
      )
      .get(draft.mappingId);
    expect(stored).toEqual({
      product_id: product.id,
      provider: 'yangmao',
      product_code: 'YM-1001',
      fulfillment_mode: 'B',
      deduction_unit: 'pack',
      version: 1,
      validated_version: null,
      validated_at: null,
      active_version_id: null,
    });

    expect(repository.getDraft(product.id)).toEqual(draft);
    expect(repository.getActiveVersion(product.id)).toBeNull();
    expect(repository.listVersions(product.id)).toEqual([]);

    server.restart();
    const reopened = createSupplierMappingRepository(server.database.db);
    expect(reopened.getDraft(product.id)).toEqual(draft);
    expect(reopened.getActiveVersion(product.id)).toBeNull();
    expect(reopened.listVersions(product.id)).toEqual([]);
  });

  it('enforces one mapping aggregate per internal product in the database itself', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const secondProduct = seedProduct(server, 'YM-FOOD-20');
    const repository = createSupplierMappingRepository(server.database.db);

    repository.saveDraft(draftInput(product.id));

    expect(() => repository.saveDraft(draftInput(product.id))).toThrowError(MappingExistsError);
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO supplier_product_mappings
             (id, product_id, provider, product_code, fulfillment_mode, deduction_unit, version, created_at, updated_at)
           VALUES ('direct-insert', ?, 'yangmao', 'YM-9999', 'A', 'pack', 1, 0, 0)`,
        )
        .run(product.id),
    ).toThrowError(/UNIQUE constraint failed: supplier_product_mappings.product_id/);
    expect(countRows(server, 'supplier_product_mappings')).toBe(1);

    // A different internal product is a different aggregate.
    repository.saveDraft({ ...draftInput(secondProduct.id), productCode: 'YM-2002' });
    expect(countRows(server, 'supplier_product_mappings')).toBe(2);
  });

  it('rejects a draft for an unknown internal product and invalid input', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    expect(() =>
      repository.saveDraft({ ...draftInput('missing-product'), productCode: 'YM-404' }),
    ).toThrowError(MappingProductNotFoundError);
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO supplier_product_mappings
             (id, product_id, provider, product_code, fulfillment_mode, deduction_unit, version, created_at, updated_at)
           VALUES ('orphan', 'missing-product', 'yangmao', 'YM-404', 'A', 'pack', 1, 0, 0)`,
        )
        .run(),
    ).toThrowError(/FOREIGN KEY constraint failed/);

    const invalidInputs: Array<[string, SaveMappingDraftInput]> = [
      ['provider', { ...draftInput(product.id), provider: 'other' }],
      ['empty code', { ...draftInput(product.id), productCode: '  ' }],
      ['free text code', { ...draftInput(product.id), productCode: 'raw json {"productCode":1}' }],
      ['spaced code', { ...draftInput(product.id), productCode: 'YM 1001' }],
      ['oversized code', { ...draftInput(product.id), productCode: `YM-${'9'.repeat(62)}` }],
      [
        'mode',
        { ...draftInput(product.id), fulfillmentMode: 'E' as unknown as FulfillmentMode },
      ],
      ['deduction unit', { ...draftInput(product.id), deductionUnit: 'points' as never }],
      ['product id', { ...draftInput('  '), productId: '  ' }],
    ];
    for (const [label, input] of invalidInputs) {
      expect(() => repository.saveDraft(input), label).toThrowError(MappingInputError);
    }
    expect(countRows(server, 'supplier_product_mappings')).toBe(0);

    // Database-level guards exist too: provider, code length and mode enums.
    repository.saveDraft(draftInput(product.id));
    expect(() =>
      server?.database.sqlite
        .prepare("UPDATE supplier_product_mappings SET provider = 'other' WHERE product_id = ?")
        .run(product.id),
    ).toThrowError(/CHECK constraint failed/);
    expect(() =>
      server?.database.sqlite
        .prepare(
          'UPDATE supplier_product_mappings SET product_code = ? WHERE product_id = ?',
        )
        .run('X'.repeat(65), product.id),
    ).toThrowError(/CHECK constraint failed/);
    expect(() =>
      server?.database.sqlite
        .prepare("UPDATE supplier_product_mappings SET fulfillment_mode = 'E' WHERE product_id = ?")
        .run(product.id),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('rejects stale draft writes and invalidates validation after an edit', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    repository.saveDraft(draftInput(product.id));
    const validated = repository.validateDraft({ productId: product.id, expectedVersion: 1 });
    expect(validated.validatedVersion).toBe(1);
    expect(validated.validatedAt).not.toBeNull();

    const edited = repository.saveDraft({
      ...draftInput(product.id),
      expectedVersion: 1,
      productCode: 'YM-2002',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });
    expect(edited).toMatchObject({
      productCode: 'YM-2002',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
      version: 2,
      validatedVersion: null,
      validatedAt: null,
    });

    // The old validation cannot authorise the new draft version.
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 2, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingNotValidatedError);

    // Neither a stale update nor a stale validation write can succeed.
    expect(() =>
      repository.saveDraft({ ...draftInput(product.id), expectedVersion: 1 }),
    ).toThrowError(MappingVersionConflictError);
    expect(() =>
      repository.validateDraft({ productId: product.id, expectedVersion: 1 }),
    ).toThrowError(MappingVersionConflictError);
    expect(repository.getDraft(product.id)?.productCode).toBe('YM-2002');
    expect(repository.getDraft(product.id)?.validatedVersion).toBeNull();
    expect(countRows(server, 'supplier_product_mapping_versions')).toBe(0);
  });
});

describe('supplier mapping local validation', () => {
  it('covers every local rule deterministically', () => {
    const valid = {
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    };
    expect(collectMappingValidationIssues(valid, { internalProductExists: true })).toEqual([]);
    expect(collectMappingValidationIssues(valid, { internalProductExists: false })).toEqual([
      'product_missing',
    ]);
    expect(
      collectMappingValidationIssues({ ...valid, provider: 'other' }, { internalProductExists: true }),
    ).toEqual(['provider_unsupported']);
    expect(
      collectMappingValidationIssues(
        { ...valid, productCode: 'raw response {"code":0}' },
        { internalProductExists: true },
      ),
    ).toEqual(['product_code_invalid']);
    expect(
      collectMappingValidationIssues(
        { ...valid, fulfillmentMode: 'E' },
        { internalProductExists: true },
      ),
    ).toEqual(['fulfillment_mode_unsupported']);

    // A/B/C are pack quota; D is monetary. Unknown units are rejected too.
    const expectedMismatch: MappingValidationIssue[] = ['deduction_unit_mismatch'];
    for (const mode of ['A', 'B', 'C'] as const) {
      expect(
        collectMappingValidationIssues(
          { ...valid, fulfillmentMode: mode, deductionUnit: 'amount' },
          { internalProductExists: true },
        ),
      ).toEqual(expectedMismatch);
    }
    expect(
      collectMappingValidationIssues(
        { ...valid, fulfillmentMode: 'D', deductionUnit: 'pack' },
        { internalProductExists: true },
      ),
    ).toEqual(expectedMismatch);
    expect(
      collectMappingValidationIssues(
        { ...valid, deductionUnit: 'points' },
        { internalProductExists: true },
      ),
    ).toEqual(expectedMismatch);
    expect(
      collectMappingValidationIssues(
        { ...valid, fulfillmentMode: 'D', deductionUnit: 'amount' },
        { internalProductExists: true },
      ),
    ).toEqual([]);
  });

  it('records validation only for the current draft version and blocks mismatched drafts', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-FOOD-20');
    const repository = createSupplierMappingRepository(server.database.db);

    const draft = repository.saveDraft({
      ...draftInput(product.id),
      fulfillmentMode: 'D',
      deductionUnit: 'pack',
    });
    expect(draft.version).toBe(1);

    const error = captureValidationError(() =>
      repository.validateDraft({ productId: product.id, expectedVersion: 1 }),
    );
    expect(error.issues).toEqual(['deduction_unit_mismatch']);
    expect(repository.getDraft(product.id)).toMatchObject({
      validatedVersion: null,
      validatedAt: null,
    });
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 1, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingNotValidatedError);

    // Correcting the pairing creates a new draft version that can validate.
    const corrected = repository.saveDraft({
      ...draftInput(product.id),
      expectedVersion: 1,
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });
    expect(corrected.version).toBe(2);
    const validated = repository.validateDraft({ productId: product.id, expectedVersion: 2 });
    expect(validated.validatedVersion).toBe(2);

    const active = repository.activateDraft({
      productId: product.id,
      expectedVersion: 2,
      actorAccountId: 'acc-1',
    });
    expect(active).toMatchObject({
      versionNumber: 1,
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
      sourceDraftVersion: 2,
    });
  });
});

describe('supplier mapping activation', () => {
  it('requires a validated current draft and atomically switches the active pointer', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    repository.saveDraft(draftInput(product.id));
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 1, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingNotValidatedError);
    expect(repository.listVersions(product.id)).toEqual([]);
    expect(countRows(server, 'supplier_product_mapping_versions')).toBe(0);

    repository.validateDraft({ productId: product.id, expectedVersion: 1 });
    const version = repository.activateDraft({
      productId: product.id,
      expectedVersion: 1,
      actorAccountId: 'acc-1',
    });
    expect(version).toMatchObject({
      mappingId: repository.getDraft(product.id)?.mappingId,
      productId: product.id,
      versionNumber: 1,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
      sourceDraftVersion: 1,
      activatedBy: 'acc-1',
    });
    expect(version.activatedAt).toBeGreaterThan(0);

    expect(repository.getActiveVersion(product.id)).toEqual(version);
    expect(repository.listVersions(product.id)).toEqual([version]);

    // Activation consumes the validation fact and advances the draft version:
    // a second activation needs an explicit re-validation.
    expect(repository.getDraft(product.id)).toMatchObject({
      version: 2,
      validatedVersion: null,
      validatedAt: null,
      activeVersionId: version.id,
    });
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 2, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingNotValidatedError);

    // The stored pointer and snapshot are the persisted evidence.
    const pointer = server.database.sqlite
      .prepare('SELECT active_version_id, version FROM supplier_product_mappings WHERE product_id = ?')
      .get(product.id);
    expect(pointer).toEqual({ active_version_id: version.id, version: 2 });
    expect(
      server.database.sqlite
        .prepare(
          `SELECT mapping_id, product_id, version_number, provider, product_code,
                  fulfillment_mode, deduction_unit, source_draft_version, activated_by
             FROM supplier_product_mapping_versions WHERE id = ?`,
        )
        .get(version.id),
    ).toEqual({
      mapping_id: version.mappingId,
      product_id: product.id,
      version_number: 1,
      provider: 'yangmao',
      product_code: 'YM-1001',
      fulfillment_mode: 'B',
      deduction_unit: 'pack',
      source_draft_version: 1,
      activated_by: 'acc-1',
    });
  });

  it('keeps every activation snapshot immutable across two sequential activations', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    repository.saveDraft(draftInput(product.id));
    repository.validateDraft({ productId: product.id, expectedVersion: 1 });
    const first = repository.activateDraft({
      productId: product.id,
      expectedVersion: 1,
      actorAccountId: 'acc-1',
    });

    repository.saveDraft({
      ...draftInput(product.id),
      expectedVersion: 2,
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
      deductionUnit: 'pack',
    });
    repository.validateDraft({ productId: product.id, expectedVersion: 3 });
    const second = repository.activateDraft({
      productId: product.id,
      expectedVersion: 3,
      actorAccountId: 'acc-2',
    });

    expect(second).toMatchObject({
      versionNumber: 2,
      sourceDraftVersion: 3,
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
      activatedBy: 'acc-2',
    });
    expect(second.id).not.toBe(first.id);

    const history = repository.listVersions(product.id);
    expect(history.map(({ versionNumber }) => versionNumber)).toEqual([1, 2]);
    expect(history[0]).toEqual(first);
    expect(history[1]).toEqual(second);
    expect(repository.getActiveVersion(product.id)).toEqual(second);

    // History is append-only at the database boundary as well.
    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE supplier_product_mapping_versions SET product_code = ? WHERE id = ?')
        .run('YM-9999', first.id),
    ).toThrowError(/immutable/);
    expect(() =>
      server?.database.sqlite
        .prepare('DELETE FROM supplier_product_mapping_versions WHERE id = ?')
        .run(first.id),
    ).toThrowError(/immutable/);
    expect(repository.listVersions(product.id)).toEqual([first, second]);
    const draftBeforeRestart = repository.getDraft(product.id);

    // Reopening the database preserves the pointer, history and draft exactly.
    server.restart();
    const reopened = createSupplierMappingRepository(server.database.db);
    expect(reopened.getActiveVersion(product.id)).toEqual(second);
    expect(reopened.listVersions(product.id)).toEqual([first, second]);
    expect(reopened.getDraft(product.id)).toEqual(draftBeforeRestart);
    expect(
      server.database.sqlite
        .prepare(
          'SELECT active_version_id, version FROM supplier_product_mappings WHERE product_id = ?',
        )
        .get(product.id),
    ).toEqual({ active_version_id: second.id, version: 4 });
  });

  it('rejects stale activation so only one accepted transition can exist', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const primary = createSupplierMappingRepository(server.database.db);
    const secondConnection = openDatabase(server.file);

    try {
      const concurrent = createSupplierMappingRepository(secondConnection.db);
      primary.saveDraft(draftInput(product.id));
      primary.validateDraft({ productId: product.id, expectedVersion: 1 });

      // Both callers believe draft version 1 is the current validated draft.
      expect(concurrent.getDraft(product.id)).toMatchObject({
        version: 1,
        validatedVersion: 1,
      });

      const accepted = primary.activateDraft({
        productId: product.id,
        expectedVersion: 1,
        actorAccountId: 'acc-1',
      });

      expect(() =>
        concurrent.activateDraft({
          productId: product.id,
          expectedVersion: 1,
          actorAccountId: 'acc-2',
        }),
      ).toThrowError(MappingVersionConflictError);

      expect(secondConnection.sqlite
        .prepare('SELECT COUNT(*) AS value FROM supplier_product_mapping_versions')
        .get()).toEqual({ value: 1 });
      expect(
        secondConnection.sqlite
          .prepare('SELECT active_version_id FROM supplier_product_mappings WHERE product_id = ?')
          .get(product.id),
      ).toEqual({ active_version_id: accepted.id });
      expect(concurrent.listVersions(product.id)).toEqual([accepted]);

      // A refresh sees the consumed validation, so a retry cannot silently
      // create a second version from the same stale assumption.
      expect(concurrent.getDraft(product.id)).toMatchObject({
        version: 2,
        validatedVersion: null,
      });
      expect(() =>
        concurrent.activateDraft({
          productId: product.id,
          expectedVersion: 2,
          actorAccountId: 'acc-2',
        }),
      ).toThrowError(MappingNotValidatedError);
      expect(countRows(server, 'supplier_product_mapping_versions')).toBe(1);
    } finally {
      secondConnection.close();
    }
  });

  it('reports stable domain errors for missing mappings and invalid activation input', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const repository = createSupplierMappingRepository(server.database.db);

    expect(repository.getDraft(product.id)).toBeNull();
    expect(repository.getActiveVersion(product.id)).toBeNull();
    expect(repository.listVersions(product.id)).toEqual([]);

    expect(() =>
      repository.saveDraft({ ...draftInput(product.id), expectedVersion: 1 }),
    ).toThrowError(MappingNotFoundError);
    expect(() =>
      repository.validateDraft({ productId: product.id, expectedVersion: 1 }),
    ).toThrowError(MappingNotFoundError);
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 1, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingNotFoundError);

    repository.saveDraft(draftInput(product.id));
    repository.validateDraft({ productId: product.id, expectedVersion: 1 });
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 1, actorAccountId: '' }),
    ).toThrowError(MappingInputError);
    expect(() =>
      repository.activateDraft({ productId: product.id, expectedVersion: 0, actorAccountId: 'acc-1' }),
    ).toThrowError(MappingInputError);
    expect(countRows(server, 'supplier_product_mapping_versions')).toBe(0);
  });
});

describe('supplier mapping schema boundaries', () => {
  it('stores no credential, contact, card-key or raw supplier response columns', () => {
    server = new TestServer();
    expect(columnsOf(server, 'supplier_product_mappings')).toEqual([
      'id',
      'product_id',
      'provider',
      'product_code',
      'fulfillment_mode',
      'deduction_unit',
      'version',
      'validated_version',
      'validated_at',
      'active_version_id',
      'created_at',
      'updated_at',
    ]);
    expect(columnsOf(server, 'supplier_product_mapping_versions')).toEqual([
      'id',
      'mapping_id',
      'product_id',
      'version_number',
      'provider',
      'product_code',
      'fulfillment_mode',
      'deduction_unit',
      'source_draft_version',
      'activated_by',
      'activated_at',
    ]);

    const sensitivePattern = /(secret|app_?key|token|password|phone|mobile|card|raw|signature|base_?url|response)/i;
    for (const table of ['supplier_product_mappings', 'supplier_product_mapping_versions']) {
      for (const column of columnsOf(server, table)) {
        expect(sensitivePattern.test(column), `${table}.${column}`).toBe(false);
      }
    }
  });

  it('enforces snapshot content, version monotonicity and active-pointer ownership in SQLite', () => {
    server = new TestServer();
    const firstProduct = seedProduct(server, 'YM-TRAVEL-10');
    const secondProduct = seedProduct(server, 'YM-FOOD-20');
    const repository = createSupplierMappingRepository(server.database.db);

    const missingActive = repository.saveDraft(draftInput(firstProduct.id));
    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE supplier_product_mappings SET active_version_id = ? WHERE id = ?')
        .run('missing-version', missingActive.mappingId),
    ).toThrowError(/active version must belong to the same mapping/);

    repository.validateDraft({ productId: firstProduct.id, expectedVersion: 1 });
    const firstVersion = repository.activateDraft({
      productId: firstProduct.id,
      expectedVersion: 1,
      actorAccountId: 'acc-1',
    });

    repository.saveDraft({ ...draftInput(secondProduct.id), productCode: 'YM-2002' });
    repository.validateDraft({ productId: secondProduct.id, expectedVersion: 1 });
    const otherVersion = repository.activateDraft({
      productId: secondProduct.id,
      expectedVersion: 1,
      actorAccountId: 'acc-1',
    });

    // A random pointer and another mapping's version are both rejected.
    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE supplier_product_mappings SET active_version_id = ? WHERE id = ?')
        .run(otherVersion.id, missingActive.mappingId),
    ).toThrowError(/active version must belong to the same mapping/);

    // A snapshot cannot claim a product different from its mapping root.
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO supplier_product_mapping_versions
             (id, mapping_id, product_id, version_number, provider, product_code,
              fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at)
           VALUES ('wrong-product', ?, ?, 8, 'yangmao', 'YM-1001', 'B', 'pack', 1, 'acc-1', 0)`,
        )
        .run(missingActive.mappingId, secondProduct.id),
    ).toThrowError(/mapping snapshot product must match mapping product/);

    // Snapshots cannot mix the two deduction ledgers.
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO supplier_product_mapping_versions
             (id, mapping_id, product_id, version_number, provider, product_code,
              fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at)
           VALUES ('bad-ledger', ?, ?, 9, 'yangmao', 'YM-1001', 'D', 'pack', 1, 'acc-1', 0)`,
        )
        .run(missingActive.mappingId, firstProduct.id),
    ).toThrowError(/CHECK constraint failed/);

    // Version numbers are unique per mapping and generated monotonically.
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO supplier_product_mapping_versions
             (id, mapping_id, product_id, version_number, provider, product_code,
              fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at)
           VALUES ('duplicate-number', ?, ?, 1, 'yangmao', 'YM-1001', 'B', 'pack', 1, 'acc-1', 0)`,
        )
        .run(firstVersion.mappingId, firstProduct.id),
    ).toThrowError(/UNIQUE constraint failed/);
  });
});

describe('supplier mapping migration upgrade', () => {
  it('upgrades a BHB-002/003/006 database without losing existing rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-mapping-upgrade-'));
    const file = join(directory, 'benefit.sqlite');
    const handle = openDatabase(file);

    try {
      expect(runMigrations(handle.sqlite, migrations.slice(0, 3))).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
      ]);

      // Representative state a deployed /data volume already contains.
      handle.sqlite
        .prepare(
          `INSERT INTO admin_accounts
             (id, username, display_name, role, password_hash, created_at, updated_at)
           VALUES ('acc-legacy', 'ops.admin', '运营管理员', 'admin', 'stored-hash', 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO admin_sessions (id, account_id, token_hash, created_at, expires_at)
           VALUES ('ses-legacy', 'acc-legacy', 'token-digest', 1000, 2000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO auth_events (id, event, account_id, detail, created_at)
           VALUES ('auth-event-legacy', 'login', 'acc-legacy', 'ok', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_products
             (id, code, name, short_description, status, display_price_cents,
              estimated_cost_cents, version, created_at, updated_at)
           VALUES ('legacy-product', 'LEGACY-1', '历史商品', '', 'active', 100, 90, 1, 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_product_events (id, product_id, actor_account_id, action, created_at)
           VALUES ('catalog-event-legacy', 'legacy-product', 'acc-legacy', 'created', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, fulfillment_mode, status,
              version, created_at, updated_at)
           VALUES ('order-legacy', 'local-life', 'LO-LEGACY-1', 'legacy-product', 'A',
                   'processing', 2, 1000, 1200)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events (id, order_id, status, version, created_at)
           VALUES ('status-legacy-1', 'order-legacy', 'pending', 1, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events (id, order_id, status, version, created_at)
           VALUES ('status-legacy-2', 'order-legacy', 'processing', 2, 1200)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO fulfillment_attempts
             (id, order_id, operation, upstream_request_no, result, observed_status, occurred_at)
           VALUES ('attempt-legacy', 'order-legacy', 'query', 'req-legacy-1', 'accepted',
                   'processing', 1200)`,
        )
        .run();

      expect(runMigrations(handle.sqlite)).toEqual([
        '0004_supplier_product_mappings',
        '0005_benefit_order_mapping_version',
        '0006_supplier_connections',
        '0007_business_applications',
        '0008_business_application_credentials',
        '0009_benefit_order_grants',
        '0010_benefit_order_gift_vouchers',
        '0011_benefit_order_direct_topups',
      ]);

      // Existing auth, catalogue and order data survives untouched.
      expect(
        handle.sqlite
          .prepare('SELECT username, role, password_hash FROM admin_accounts')
          .get(),
      ).toEqual({ username: 'ops.admin', role: 'admin', password_hash: 'stored-hash' });
      expect(handle.sqlite.prepare('SELECT id FROM admin_sessions').get()).toEqual({
        id: 'ses-legacy',
      });
      expect(handle.sqlite.prepare('SELECT id FROM auth_events').get()).toEqual({
        id: 'auth-event-legacy',
      });
      expect(handle.sqlite.prepare('SELECT code FROM catalog_products').get()).toEqual({
        code: 'LEGACY-1',
      });
      expect(handle.sqlite.prepare('SELECT id FROM catalog_product_events').get()).toEqual({
        id: 'catalog-event-legacy',
      });
      expect(
        handle.sqlite
          .prepare(
            `SELECT business_source, business_order_no, product_id, fulfillment_mode,
                    status, version, mapping_version_id FROM benefit_orders WHERE id = 'order-legacy'`,
          )
          .get(),
      ).toEqual({
        business_source: 'local-life',
        business_order_no: 'LO-LEGACY-1',
        product_id: 'legacy-product',
        fulfillment_mode: 'A',
        status: 'processing',
        version: 2,
        mapping_version_id: null,
      });
      expect(
        handle.sqlite
          .prepare(
            'SELECT status, version FROM benefit_order_status_events WHERE order_id = ? ORDER BY version',
          )
          .all('order-legacy'),
      ).toEqual([
        { status: 'pending', version: 1 },
        { status: 'processing', version: 2 },
      ]);
      expect(
        handle.sqlite
          .prepare(
            `SELECT operation, upstream_request_no, result, observed_status
               FROM fulfillment_attempts WHERE id = 'attempt-legacy'`,
          )
          .get(),
      ).toEqual({
        operation: 'query',
        upstream_request_no: 'req-legacy-1',
        result: 'accepted',
        observed_status: 'processing',
      });

      const tables = (
        handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toContain('supplier_product_mappings');
      expect(tables).toContain('supplier_product_mapping_versions');

      // The new lifecycle works on the upgraded schema and existing product.
      const repository: SupplierMappingRepository = createSupplierMappingRepository(handle.db);
      repository.saveDraft({
        productId: 'legacy-product',
        provider: 'yangmao',
        productCode: 'YM-LEGACY-1',
        fulfillmentMode: 'A',
        deductionUnit: 'pack',
      });
      repository.validateDraft({ productId: 'legacy-product', expectedVersion: 1 });
      const version = repository.activateDraft({
        productId: 'legacy-product',
        expectedVersion: 1,
        actorAccountId: 'acc-legacy',
      });
      expect(version).toMatchObject({ productId: 'legacy-product', versionNumber: 1 });

      // Re-running the migration list is a no-op on every restart.
      expect(runMigrations(handle.sqlite)).toEqual([]);
      expect(
        handle.sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '0001_admin_auth' },
        { id: '0002_catalog_products' },
        { id: '0003_benefit_orders' },
        { id: '0004_supplier_product_mappings' },
        { id: '0005_benefit_order_mapping_version' },
        { id: '0006_supplier_connections' },
        { id: '0007_business_applications' },
        { id: '0008_business_application_credentials' },
        { id: '0009_benefit_order_grants' },
        { id: '0010_benefit_order_gift_vouchers' },
        { id: '0011_benefit_order_direct_topups' },
      ]);
      expect(migrations.map((migration) => migration.id)).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
        '0005_benefit_order_mapping_version',
        '0006_supplier_connections',
        '0007_business_applications',
        '0008_business_application_credentials',
        '0009_benefit_order_grants',
        '0010_benefit_order_gift_vouchers',
        '0011_benefit_order_direct_topups',
      ]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
