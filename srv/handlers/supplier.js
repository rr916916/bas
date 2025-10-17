// srv/handlers/supplier.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { parseODataV2Date, logProcess } = require('../utils/helpers');

const MODEL = process.env.EMBEDDINGS_MODEL || 'SAP_GXY.20250407';

module.exports = function(srv) {
  const LOG = cds.log('supplier');
  const { InvoiceHeader, SupplierVector } = srv.entities;

  // ============================================
  // MATCH SUPPLIER - WITH GEOGRAPHIC BOOST
  // ============================================
  srv.on('MatchSupplier', async (req) => {
    const { headerId } = req.data;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    // Get invoice header with all address fields
    const header = await tx.read(InvoiceHeader, headerId, [
      'ID', 'senderName', 'receiverName', 'senderAddress', 
      'senderCity', 'senderState', 'senderPostalCode'
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
    if (header.senderCity) LOG.info(`  City: ${header.senderCity}`);
    if (header.senderState) LOG.info(`  State: ${header.senderState}`);
    if (header.senderPostalCode) LOG.info(`  ZIP: ${header.senderPostalCode}`);

    try {
      const physicalTable = 'JUNO_INVOICE_ASSISTANT_V1_SUPPLIERVECTOR';
      
      // Step 1: Vector search on name (get top 10 candidates)
      const rows = await tx.run(`
        SELECT
          "SUPPLIERNUMBER" as "supplierNumber",
          "SUPPLIERNAME" as "supplierName",
          "ALTNAMES" as "altNames",
          "STREET" as "street",
          "CITY" as "city",
          "STATE" as "state",
          "POSTALCODE" as "postalCode",
          "COUNTRY" as "country",
          COSINE_SIMILARITY(
            VECTOR_EMBEDDING(?, 'DOCUMENT', ?),
            "EMBEDDING"
          ) AS "nameScore"
        FROM "${physicalTable}"
        WHERE "EMBEDDING" IS NOT NULL
          AND "ISACTIVE" = TRUE
        ORDER BY "nameScore" DESC
        LIMIT 10
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

      // Step 2: Apply geographic boost to top candidates
      const scoredResults = rows.map(row => {
        let finalScore = row.nameScore;
        let boostFactors = [];

        // Boost if city matches (case-insensitive)
        if (header.senderCity && row.city) {
          const invoiceCity = header.senderCity.trim().toUpperCase();
          const supplierCity = row.city.trim().toUpperCase();
          
          if (invoiceCity === supplierCity) {
            finalScore += 0.05;
            boostFactors.push('CITY');
            LOG.info(`  ✓ City match: ${row.city}`);
          }
        }

        // Boost if state matches
        if (header.senderState && row.state) {
          const invoiceState = header.senderState.trim().toUpperCase();
          const supplierState = row.state.trim().toUpperCase();
          
          if (invoiceState === supplierState) {
            finalScore += 0.03;
            boostFactors.push('STATE');
            LOG.info(`  ✓ State match: ${row.state}`);
          }
        }

        // Boost if postal code matches (first 5 digits)
        if (header.senderPostalCode && row.postalCode) {
          const invoiceZip = header.senderPostalCode.replace(/[^0-9]/g, '').substring(0, 5);
          const supplierZip = row.postalCode.replace(/[^0-9]/g, '').substring(0, 5);
          
          if (invoiceZip && supplierZip && invoiceZip === supplierZip) {
            finalScore += 0.02;
            boostFactors.push('ZIP');
            LOG.info(`  ✓ ZIP match: ${supplierZip}`);
          }
        }

        // Cap at 1.0
        finalScore = Math.min(finalScore, 1.0);

        return {
          ...row,
          originalScore: row.nameScore,
          finalScore,
          boostFactors: boostFactors.length > 0 ? boostFactors.join('+') : 'NONE'
        };
      });

      // Step 3: Sort by final score
      scoredResults.sort((a, b) => b.finalScore - a.finalScore);

      const bestMatch = scoredResults[0];
      const matchScore = bestMatch.finalScore;

      // Step 4: Determine confidence based on final score
      let confidence = 'LOW';
      let matchStatus = 'MANUAL_REVIEW';

      if (matchScore >= 0.95) {
        confidence = 'HIGH';
        matchStatus = 'MATCHED';
      } else if (matchScore >= 0.85) {
        confidence = 'MEDIUM';
        matchStatus = 'MATCHED';
      } else if (matchScore >= 0.70) {
        confidence = 'LOW';
        matchStatus = 'MANUAL_REVIEW';
      } else {
        confidence = 'VERY_LOW';
        matchStatus = 'NO_MATCH';
      }

      LOG.info(`✓ Best match: ${bestMatch.supplierName} (${bestMatch.supplierNumber})`);
      LOG.info(`  - Name score: ${bestMatch.originalScore.toFixed(4)}`);
      LOG.info(`  - Geographic boosts: ${bestMatch.boostFactors}`);
      LOG.info(`  - Final score: ${matchScore.toFixed(4)}`);
      LOG.info(`  - Confidence: ${confidence}`);

      // Step 5: Update invoice header
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

      // Update supplier last used timestamp
      await tx.update(SupplierVector, bestMatch.supplierNumber).set({
        lastChangedAt: new Date()
      });

      // Log detailed results
      await logProcess(tx, headerId, 'MATCH_SUPPLIER', matchStatus,
        matchStatus === 'MATCHED' ? 'SUCCESS' : 'PARTIAL',
        `Matched to ${bestMatch.supplierName} (name: ${bestMatch.originalScore.toFixed(4)}, boosts: ${bestMatch.boostFactors}, final: ${matchScore.toFixed(4)})`,
        {
          topMatches: scoredResults.slice(0, 3).map(r => ({
            supplier: r.supplierNumber,
            name: r.supplierName,
            city: r.city,
            state: r.state,
            nameScore: r.originalScore,
            finalScore: r.finalScore,
            boosts: r.boostFactors
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
  // SYNC SUPPLIERS FROM SAP
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
        
        LOG.info(`Synced ${totalSynced}/${suppliers.length} suppliers`);
      }

      // Refresh embeddings
      let embeddingsRefreshed = false;
      try {
        const result = await srv.send({ event: 'RefreshSupplierEmbeddings' });
        embeddingsRefreshed = result && result.value === 1;
        LOG.info(`Supplier embeddings refreshed: ${embeddingsRefreshed}`);
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
    const db = cds.db;
    const physicalTable = 'JUNO_INVOICE_ASSISTANT_V1_SUPPLIERVECTOR';

    try {
      // Generate embeddings from name + alternative names only
      // Using DOCUMENT type for symmetric name-to-name matching
      await db.run(`
        UPDATE "${physicalTable}"
        SET "EMBEDDING" = VECTOR_EMBEDDING(
          COALESCE("SUPPLIERNAME",'') || ' ' || COALESCE("ALTNAMES",''),
          'DOCUMENT',
          ?
        ),
        "LASTREFRESHED" = CURRENT_UTCTIMESTAMP
        WHERE "EMBEDDING" IS NULL
           OR "LASTREFRESHED" IS NULL
           OR DAYS_BETWEEN("LASTREFRESHED", CURRENT_UTCTIMESTAMP) > 7
      `, [MODEL]);

      LOG.info('Supplier embeddings refreshed successfully');
      return { value: 1, message: 'Embeddings refreshed successfully' };

    } catch (error) {
      LOG.warn(`Embeddings service unavailable: ${error.message}`);
      
      // Fallback: just update timestamp
      try {
        await db.run(`
          UPDATE "${physicalTable}"
          SET "LASTREFRESHED" = CURRENT_UTCTIMESTAMP
          WHERE "LASTREFRESHED" IS NULL
             OR DAYS_BETWEEN("LASTREFRESHED", CURRENT_UTCTIMESTAMP) > 7
        `);
      } catch (e) {
        // Ignore
      }

      return { value: 0, message: `Embeddings unavailable: ${error.message}` };
    }
  });

  // ============================================
  // FETCH SUPPLIERS FROM SAP - WITH ADDRESSES
  // ============================================
  async function fetchSuppliersFromSAP(destName, client, mode, since) {
    const PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';
    const SELECT = [
      'BusinessPartner',
      'BusinessPartnerFullName',
      'BusinessPartnerName',
      'SearchTerm1',
      'SearchTerm2',
      'Supplier',
      'LastChangeDate',
      'CreationDate',
      'BusinessPartnerIsBlocked',
      'OrganizationBPName1',
      'OrganizationBPName2'
    ].join(',');

    let filter = `Supplier ne ''`;

    if (mode === 'delta' && since) {
      const sinceDate = since.toISOString().split('T')[0];
      filter += ` and LastChangeDate ge datetime'${sinceDate}T00:00:00'`;
    }

    // Expand to get address information
    const expand = 'to_BusinessPartnerAddress';

    const url = buildUrl(PATH, {
      $select: SELECT,
      $filter: filter,
      $expand: expand,
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

    // Get primary address from expanded navigation
    const addresses = row.to_BusinessPartnerAddress?.results || 
                     row.to_BusinessPartnerAddress || 
                     [];
    
    // Find primary address (AddressID = '1') or use first available
    const primaryAddress = Array.isArray(addresses) 
      ? (addresses.find(a => a.AddressID === '1') || addresses[0] || {})
      : addresses;

    // Build alternative names from all available sources
    const altNames = [
      row.SearchTerm1,
      row.SearchTerm2,
      row.OrganizationBPName1,
      row.OrganizationBPName2
    ].filter(Boolean).join(' ').trim();

    return {
      supplierNumber: row.Supplier,
      supplierName: row.BusinessPartnerFullName || row.BusinessPartnerName || '',
      altNames: altNames || '',
      
      // Address fields
      street: primaryAddress.StreetName || '',
      city: primaryAddress.CityName || '',
      postalCode: primaryAddress.PostalCode || '',
      state: primaryAddress.Region || '',
      country: primaryAddress.Country || '',
      
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
};