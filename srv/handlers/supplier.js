// srv/handlers/supplier.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { parseODataV2Date, logProcess } = require('../utils/helpers');

const MODEL = process.env.EMBEDDINGS_MODEL || 'SAP_GXY.20250407';

module.exports = function(srv) {
  const LOG = cds.log('supplier');
  const { InvoiceHeader, SupplierVector } = srv.entities;

  // ============================================
  // MATCH SUPPLIER
  // ============================================
  srv.on('MatchSupplier', async (req) => {
    const { headerId } = req.data;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    // Get invoice header
    const header = await tx.read(InvoiceHeader, headerId, [
      'ID', 'senderName', 'receiverName', 'senderAddress', 'senderCity'
    ]);

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    // Determine supplier name to search
    const supplierName = header.senderName || header.receiverName;

    if (!supplierName) {
      await tx.update(InvoiceHeader, headerId).set({
        supplierMatchStatus: 'NO_MATCH',
        step: 'SUPPLIER_MATCH_FAILED',
        message: 'No supplier name found in invoice'
      });

      await logProcess(tx, headerId, 'MATCH_SUPPLIER', 'FAILED', 'FAILURE',
        'No supplier name available for matching');

      LOG.warn(`No supplier name found for invoice ${headerId}`);

      return {
        supplierNumber: null,
        supplierName: null,
        matchScore: 0,
        confidence: 'NONE',
        status: 'NO_MATCH',
        message: 'No supplier name found on invoice'
      };
    }

    LOG.info(`Matching supplier for invoice ${headerId}: "${supplierName}"`);

    try {
      // Vector-based search
      const rows = await tx.run(`
        SELECT
          "supplierNumber",
          "supplierName",
          "altNames",
          "city",
          COSINE_SIMILARITY(
            VECTOR_EMBEDDING(?, 'QUERY', ?),
            "embedding"
          ) AS "score"
        FROM "${SupplierVector.name}"
        WHERE "embedding" IS NOT NULL
          AND "isActive" = TRUE
        ORDER BY "score" DESC
        LIMIT 5
      `, [supplierName.trim(), MODEL]);

      if (!rows || rows.length === 0) {
        LOG.warn(`No supplier matches found for: "${supplierName}"`);

        await tx.update(InvoiceHeader, headerId).set({
          supplierMatchStatus: 'NO_MATCH',
          step: 'SUPPLIER_MATCH_FAILED',
          message: `No supplier match found for: ${supplierName}`
        });

        await logProcess(tx, headerId, 'MATCH_SUPPLIER', 'NO_MATCH', 'FAILURE',
          `No supplier found for: ${supplierName}`);

        return {
          supplierNumber: null,
          supplierName: null,
          matchScore: 0,
          confidence: 'NONE',
          status: 'NO_MATCH',
          message: `No supplier found matching "${supplierName}"`
        };
      }

      const bestMatch = rows[0];
      const matchScore = bestMatch.score;

      // Determine confidence
      let confidence = 'LOW';
      let matchStatus = 'MANUAL_REVIEW';

      if (matchScore >= 0.9) {
        confidence = 'HIGH';
        matchStatus = 'MATCHED';
      } else if (matchScore >= 0.75) {
        confidence = 'MEDIUM';
        matchStatus = 'MATCHED';
      } else if (matchScore >= 0.6) {
        confidence = 'LOW';
        matchStatus = 'MANUAL_REVIEW';
      } else {
        confidence = 'VERY_LOW';
        matchStatus = 'NO_MATCH';
      }

      LOG.info(`Supplier matched: ${bestMatch.supplierName} (score: ${matchScore.toFixed(4)}, confidence: ${confidence})`);

      // Update header
      await tx.update(InvoiceHeader, headerId).set({
        matchedSupplierNumber: bestMatch.supplierNumber,
        matchedSupplierName: bestMatch.supplierName,
        supplierMatchScore: matchScore,
        supplierMatchStatus: matchStatus,
        supplier: bestMatch.supplierNumber,
        supplierName: bestMatch.supplierName,
        step: 'SUPPLIER_MATCHED',
        message: `Supplier matched: ${bestMatch.supplierName} (${confidence} confidence, score: ${(matchScore * 100).toFixed(1)}%)`
      });

      // Update supplier statistics
      await tx.update(SupplierVector, bestMatch.supplierNumber).set({
        lastChangedAt: new Date()
      });

      await logProcess(tx, headerId, 'MATCH_SUPPLIER', matchStatus, 
        matchStatus === 'MATCHED' ? 'SUCCESS' : 'PARTIAL',
        `Matched to ${bestMatch.supplierName} (score: ${matchScore.toFixed(4)})`,
        { 
          topMatches: rows.slice(0, 3).map(r => ({
            supplier: r.supplierNumber,
            name: r.supplierName,
            score: r.score
          }))
        }
      );

      return {
        supplierNumber: bestMatch.supplierNumber,
        supplierName: bestMatch.supplierName,
        matchScore,
        confidence,
        status: matchStatus,
        message: `Supplier matched with ${confidence} confidence (${(matchScore * 100).toFixed(1)}%)`
      };

    } catch (error) {
      LOG.error('Supplier matching failed:', error);

      await tx.update(InvoiceHeader, headerId).set({
        supplierMatchStatus: 'ERROR',
        step: 'SUPPLIER_MATCH_ERROR',
        lastError: error.message,
        lastErrorAt: new Date()
      });

      await logProcess(tx, headerId, 'MATCH_SUPPLIER', 'ERROR', 'FAILURE',
        `Supplier matching error: ${error.message}`);

      req.error(500, `Supplier matching failed: ${error.message}`);
    }
  });

  // ============================================
  // SYNC SUPPLIERS
  // ============================================
  srv.on('SyncSuppliers', async (req) => {
    const { mode = 'delta', since } = req.data;
    const tx = cds.tx(req);
    const startTime = Date.now();

    LOG.info(`Starting supplier sync: mode=${mode}`);

    const DEST_NAME = process.env.S4_DEST_NAME || 'S4HANA';
    const SAP_CLIENT = process.env.S4_CLIENT || '100';

    try {
      const suppliers = await fetchSuppliersFromSAP(DEST_NAME, SAP_CLIENT, mode, since);

      LOG.info(`Fetched ${suppliers.length} suppliers from SAP`);

      // Upsert suppliers
      let totalSynced = 0;
      const CHUNK_SIZE = 200;

      for (let i = 0; i < suppliers.length; i += CHUNK_SIZE) {
        const chunk = suppliers.slice(i, i + CHUNK_SIZE);
        await tx.run(UPSERT.into(SupplierVector).entries(chunk));
        totalSynced += chunk.length;
      }

      // Refresh embeddings
      let embeddingsRefreshed = false;
      try {
        await srv.send({ event: 'RefreshSupplierEmbeddings' });
        embeddingsRefreshed = true;
        LOG.info('Supplier embeddings refreshed');
      } catch (e) {
        LOG.warn(`Embeddings not refreshed: ${e.message}`);
      }

      const duration = Date.now() - startTime;

      LOG.info(`Supplier sync completed: ${totalSynced} synced in ${duration}ms`);

      return {
        totalSynced,
        embeddingsRefreshed,
        duration
      };

    } catch (error) {
      LOG.error('Supplier sync failed:', error);
      req.error(500, `Supplier sync failed: ${error.message}`);
    }
  });

  // ============================================
  // REFRESH EMBEDDINGS
  // ============================================
  srv.on('RefreshSupplierEmbeddings', async (req) => {
    const tx = cds.tx(req);

    const physicalTable = getPhysicalTableName(SupplierVector);
    const docExpr = `COALESCE("SUPPLIERNAME",'') || ' ' || COALESCE("ALTNAMES",'') || ' ' || COALESCE("CITY",'')`;

    try {
      await tx.run(`
        UPDATE "${physicalTable}"
        SET "EMBEDDING" = VECTOR_EMBEDDING(${docExpr}, 'DOCUMENT', ?),
            "LASTREFRESHED" = CURRENT_UTCTIMESTAMP
        WHERE "EMBEDDING" IS NULL
           OR "LASTREFRESHED" IS NULL
           OR DAYS_BETWEEN("LASTREFRESHED", CURRENT_UTCTIMESTAMP) > 7
      `, [MODEL]);

      LOG.info('Supplier embeddings refreshed successfully');
      return 1;

    } catch (error) {
      LOG.warn(`Embeddings service unavailable: ${error.message}`);
      
      // Fallback: update timestamp only
      await tx.run(`
        UPDATE "${physicalTable}"
        SET "LASTREFRESHED" = CURRENT_UTCTIMESTAMP
        WHERE "LASTREFRESHED" IS NULL
           OR DAYS_BETWEEN("LASTREFRESHED", CURRENT_UTCTIMESTAMP) > 7
      `);

      return 0;
    }
  });

    // ============================================
  // HELPER: FETCH SUPPLIERS FROM SAP
  // ============================================
  async function fetchSuppliersFromSAP(destName, client, mode, since) {
    const PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';
    const SELECT = [
      'BusinessPartner', 'BusinessPartnerFullName', 'BusinessPartnerName',
      'SearchTerm1', 'SearchTerm2', 'Supplier', 'LastChangeDate',
      'CreationDate', 'BusinessPartnerIsBlocked'
    ].join(',');

    let filter = `Supplier ne ''`;

    if (mode === 'delta' && since) {
      const sinceDate = since.toISOString().split('T')[0];
      filter += ` and LastChangeDate ge datetime'${sinceDate}T00:00:00'`;
    }

    const url = buildUrl(PATH, {
      $select: SELECT,
      $filter: filter,
      $top: 5000,
      'sap-client': client,
      $format: 'json'
    });

    LOG.info(`Fetching suppliers from SAP: ${PATH}`);

    const { data } = await executeHttpRequest(
      { destinationName: destName },
      { method: 'GET', url, headers: { Accept: 'application/json' } }
    );

    const results = data?.d?.results || data?.value || [];

    return results
      .filter(r => r.Supplier && r.BusinessPartnerIsBlocked !== 'X')
      .map(mapSupplierRow);
  }

  function mapSupplierRow(row) {
    const lastChanged = parseODataV2Date(row.LastChangeDate) ||
                       parseODataV2Date(row.CreationDate) ||
                       new Date();

    return {
      supplierNumber: row.Supplier,
      supplierName: row.BusinessPartnerFullName || row.BusinessPartnerName || '',
      altNames: [row.SearchTerm1, row.SearchTerm2].filter(Boolean).join(' ').trim(),
      isActive: true,
      lastChangedAt: lastChanged
    };
  }

  function buildUrl(path, params) {
    const url = new URL('http://dummy' + path);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    });
    return url.pathname + url.search;
  }

  function getPhysicalTableName(entity) {
    const m = cds.model?.definitions || {};
    const entityName = entity.name;
    let def = m[entityName];

    if (!def && m[entityName]) {
      const proj = m[entityName];
      if (proj?.source && m[proj.source]) {
        def = m[proj.source];
      }
    }

    if (def && def['@cds.persistence.name']) {
      return def['@cds.persistence.name'];
    }

    return entityName.replace(/\./g, '_').toUpperCase();
  }
};