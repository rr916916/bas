// srv/handlers/supplier-utils.js
const cds = require('@sap/cds');

module.exports = function(srv) {
  const LOG = cds.log('supplier-utils');
  const { SupplierVector } = srv.entities;

  // ============================================
  // GET SUPPLIER CANDIDATES
  // ============================================
  srv.on('GetSupplierCandidates', async (req) => {
    // BPA sends as flat key-value pairs
    const headerId = req.data.headerId;
    const limit = req.data.limit || 5;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);
    const MODEL = process.env.EMBEDDINGS_MODEL || 'SAP_GXY.20250407';

    try {
      const { InvoiceHeader } = srv.entities;
      
      const header = await tx.read(InvoiceHeader, headerId, [
        'senderName', 'senderCity', 'senderState', 'senderPostalCode'
      ]);

      if (!header || !header.senderName) {
        return [];
      }

      const physicalTable = 'JUNO_INVOICE_ASSISTANT_V1_SUPPLIERVECTOR';

      const rows = await tx.run(`
        SELECT
          "SUPPLIERNUMBER" as "supplierNumber",
          "SUPPLIERNAME" as "supplierName",
          "ALTNAMES" as "altNames",
          "CITY" as "city",
          "STATE" as "state",
          "POSTALCODE" as "postalCode",
          COSINE_SIMILARITY(
            VECTOR_EMBEDDING(?, 'DOCUMENT', ?),
            "EMBEDDING"
          ) AS "nameScore"
        FROM "${physicalTable}"
        WHERE "EMBEDDING" IS NOT NULL
          AND "ISACTIVE" = TRUE
        ORDER BY "nameScore" DESC
        LIMIT ?
      `, [header.senderName.trim(), MODEL, limit * 2]);

      if (!rows || rows.length === 0) {
        return [];
      }

      const scored = rows.map(row => {
        let finalScore = row.nameScore;
        let boosts = [];

        if (header.senderCity && row.city &&
            header.senderCity.trim().toUpperCase() === row.city.trim().toUpperCase()) {
          finalScore += 0.05;
          boosts.push('CITY');
        }

        if (header.senderState && row.state &&
            header.senderState.trim().toUpperCase() === row.state.trim().toUpperCase()) {
          finalScore += 0.03;
          boosts.push('STATE');
        }

        if (header.senderPostalCode && row.postalCode) {
          const invZip = header.senderPostalCode.replace(/[^0-9]/g, '').substring(0, 5);
          const supZip = row.postalCode.replace(/[^0-9]/g, '').substring(0, 5);
          if (invZip && supZip && invZip === supZip) {
            finalScore += 0.02;
            boosts.push('ZIP');
          }
        }

        return {
          supplierNumber: row.supplierNumber,
          supplierName: row.supplierName,
          altNames: row.altNames,
          city: row.city,
          state: row.state,
          postalCode: row.postalCode,
          matchScore: Math.min(finalScore, 1.0),
          originalScore: row.nameScore,
          boostFactors: boosts.length > 0 ? boosts.join('+') : 'NONE'
        };
      });

      scored.sort((a, b) => b.matchScore - a.matchScore);

      LOG.info(`Found ${scored.length} supplier candidates for invoice ${headerId}`);

      return scored.slice(0, limit);

    } catch (error) {
      LOG.error('Failed to get supplier candidates:', error);
      return [];
    }
  });

  // ============================================
  // VALIDATE SUPPLIER NUMBER
  // ============================================
  srv.on('ValidateSupplierNumber', async (req) => {
    // BPA sends as flat key-value pairs
    const supplierNumber = req.data.supplierNumber;

    if (!supplierNumber) {
      return {
        valid: false,
        supplierExists: false,
        supplierNumber: null,
        supplierName: null,
        isActive: false,
        message: 'Supplier number is required'
      };
    }

    const tx = cds.tx(req);

    try {
      const paddedNumber = supplierNumber.padStart(10, '0');
      
      const supplier = await tx.read(SupplierVector, paddedNumber, [
        'supplierNumber', 'supplierName', 'isActive'
      ]);

      if (!supplier) {
        LOG.warn(`Supplier not found: ${paddedNumber}`);
        return {
          valid: false,
          supplierExists: false,
          supplierNumber: paddedNumber,
          supplierName: null,
          isActive: false,
          message: `Supplier ${paddedNumber} not found in master data`
        };
      }

      if (!supplier.isActive) {
        LOG.warn(`Supplier is inactive: ${paddedNumber}`);
        return {
          valid: false,
          supplierExists: true,
          supplierNumber: paddedNumber,
          supplierName: supplier.supplierName,
          isActive: false,
          message: `Supplier ${paddedNumber} is inactive`
        };
      }

      LOG.info(`Supplier validated: ${paddedNumber} - ${supplier.supplierName}`);

      return {
        valid: true,
        supplierExists: true,
        supplierNumber: paddedNumber,
        supplierName: supplier.supplierName,
        isActive: true,
        message: 'Supplier is valid and active'
      };

    } catch (error) {
      LOG.error('Supplier validation failed:', error);
      return {
        valid: false,
        supplierExists: false,
        supplierNumber: supplierNumber,
        supplierName: null,
        isActive: false,
        message: `Validation error: ${error.message}`
      };
    }
  });
};