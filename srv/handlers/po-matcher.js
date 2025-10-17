// srv/handlers/po-matcher.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { parseJSON, logProcess, toNumber, toBoolean } = require('../utils/helpers');

const MODEL = process.env.EMBEDDINGS_MODEL || 'SAP_GXY.20250407';

module.exports = function(srv) {
  const LOG = cds.log('po-matcher');
  const { InvoiceHeader, DOXInvoiceItem, SAPPOItem } = srv.entities;

  // ============================================
  // MATCH PO ITEMS
  // ============================================
  srv.on('MatchPOItems', async (req) => {
    const { headerId, poNumber, fetchFromSAP = true } = req.data;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    // Get header
    const header = await tx.read(InvoiceHeader, headerId, [
      'ID', 'purchaseOrderNumber', 'companyCode'
    ]);

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    const finalPO = poNumber || header.purchaseOrderNumber;

    if (!finalPO) {
      await tx.update(InvoiceHeader, headerId).set({
        poMatchStatus: 'NO_MATCH',
        step: 'PO_MATCH_SKIPPED',
        message: 'No PO number provided'
      });

      LOG.warn(`No PO number for invoice ${headerId}`);

      return {
        totalDoxItems: 0,
        matchedItems: 0,
        unmatchedItems: 0,
        threeWayMatchRequired: false,
        threeWayMatchPassed: false,
        confidence: 'NONE',
        status: 'NO_PO',
        message: 'No PO number available for matching',
        matches: []
      };
    }

    LOG.info(`Matching PO items for invoice ${headerId}, PO: ${finalPO}`);

    try {
      // Fetch PO data from SAP if needed
      if (fetchFromSAP) {
        LOG.info(`Fetching PO ${finalPO} from SAP`);
        
        try {
          await srv.send({
            event: 'SyncPOFromSAP',
            data: { poNumber: finalPO, headerId }
          });
        } catch (sapError) {
          LOG.warn(`SAP fetch failed, will try to match with existing data: ${sapError.message}`);
          // Continue anyway - maybe we have cached PO data
        }
      }

      // Get DOX items
      const doxItems = await tx.read(DOXInvoiceItem).where({
        invoiceHeader_ID: headerId
      });

      if (!doxItems || doxItems.length === 0) {
        LOG.warn(`No DOX items found for invoice ${headerId}`);
        
        return {
          totalDoxItems: 0,
          matchedItems: 0,
          unmatchedItems: 0,
          threeWayMatchRequired: false,
          threeWayMatchPassed: false,
          confidence: 'NONE',
          status: 'NO_ITEMS',
          message: 'No DOX items to match',
          matches: []
        };
      }

      LOG.info(`Matching ${doxItems.length} DOX items to PO ${finalPO}`);

      const matches = [];
      let matchedCount = 0;
      let threeWayMatchRequired = false;
      let grChecksPassed = 0;
      let grChecksRequired = 0;

      // Match each DOX item
      for (const doxItem of doxItems) {
        const query = [
          doxItem.materialNumber,
          doxItem.description
        ].filter(Boolean).join(' ');

        if (!query) {
          LOG.warn(`DOX item ${doxItem.ID} (line ${doxItem.lineNumber}) has no material/description`);
          continue;
        }

        // Vector search for best PO item match - use physical table name
        const physicalTable = 'JUNO_INVOICE_ASSISTANT_V1_SAPPOITEM';
        
        const poMatches = await tx.run(`
          SELECT
            "ID", "PURCHASEORDER" as "PurchaseOrder", "PURCHASEORDERITEM" as "PurchaseOrderItem",
            "MATERIAL" as "Material", "MATERIALNAME" as "MaterialName",
            "ORDERQUANTITY" as "OrderQuantity", "OPENQUANTITY" as "OpenQuantity", 
            "GRQUANTITYPOSTED" as "GrQuantityPosted",
            "INVOICEISEXPECTED" as "InvoiceIsExpected", 
            "GOODSRECEIPTISEXPECTED" as "GoodsReceiptIsExpected",
            "INVOICEISGOODSRECEIPTBASED" as "InvoiceIsGoodsReceiptBased",
            "NETPRICEAMOUNT" as "NetPriceAmount", "CURRENCY" as "Currency",
            COSINE_SIMILARITY(
              VECTOR_EMBEDDING(?, 'DOCUMENT', ?),
              "EMBEDDING"
            ) AS "matchScore"
          FROM "${physicalTable}"
          WHERE "PURCHASEORDER" = ?
            AND "INVOICEHEADER_ID" = ?
          ORDER BY "matchScore" DESC
          LIMIT 3
        `, [query, MODEL, finalPO, headerId]);

        if (poMatches && poMatches.length > 0) {
          const bestMatch = poMatches[0];
          const matchScore = bestMatch.matchScore;

          // Accept any match score >= 0.3 (very permissive for cross-system matching)
          // Business logic will decide if manual review needed
          if (matchScore >= 0.3) {
            // Update DOX item with match
            await tx.update(DOXInvoiceItem, doxItem.ID).set({
              matchStatus: 'MATCHED',
              matchedPOItem_ID: bestMatch.ID,
              matchScore
            });

            matchedCount++;

            // Check 3-way match requirements
            if (bestMatch.InvoiceIsGoodsReceiptBased) {
              threeWayMatchRequired = true;
              grChecksRequired++;

              const grPosted = toNumber(bestMatch.GrQuantityPosted, 3) || 0;
              if (grPosted > 0) {
                grChecksPassed++;
              }
            }

            matches.push({
              doxItemId: doxItem.ID,
              doxDescription: doxItem.description,
              doxMaterial: doxItem.materialNumber,
              doxQuantity: doxItem.quantity,
              poItemId: bestMatch.ID,
              poMaterial: bestMatch.Material,
              poDescription: bestMatch.MaterialName,
              poQuantity: bestMatch.OrderQuantity,
              poOpenQuantity: bestMatch.OpenQuantity,
              matchScore,
              grPosted: bestMatch.GrQuantityPosted
            });

            LOG.info(`DOX item ${doxItem.lineNumber} matched to PO item ${bestMatch.PurchaseOrderItem} (score: ${matchScore.toFixed(4)})`);
          } else {
            // Still log the best match even if score is low
            LOG.warn(`DOX item ${doxItem.lineNumber} best match score: ${matchScore.toFixed(4)} (below threshold 0.3)`);
            LOG.warn(`  DOX: ${query}`);
            LOG.warn(`  PO:  ${bestMatch.Material || 'no-material'} ${bestMatch.MaterialName}`);
            
            await tx.update(DOXInvoiceItem, doxItem.ID).set({
              matchStatus: 'NO_MATCH',
              matchScore
            });
          }
        } else {
          await tx.update(DOXInvoiceItem, doxItem.ID).set({
            matchStatus: 'NO_MATCH'
          });

          LOG.warn(`No PO item match found for DOX item ${doxItem.lineNumber}`);
        }
      }

      // Calculate confidence
      const matchRate = matchedCount / doxItems.length;
      let confidence = 'LOW';
      if (matchRate >= 0.9) confidence = 'HIGH';
      else if (matchRate >= 0.7) confidence = 'MEDIUM';

      // Determine 3-way match status
      const threeWayMatchPassed = !threeWayMatchRequired || 
                                  (grChecksPassed === grChecksRequired && grChecksRequired > 0);

      // Update header
      const poMatchStatus = matchedCount === doxItems.length ? 'MATCHED' :
                           matchedCount > 0 ? 'PARTIAL' : 'NO_MATCH';

      await tx.update(InvoiceHeader, headerId).set({
        poMatchStatus,
        poMatchConfidence: matchRate * 100,
        threeWayMatchRequired,
        threeWayMatchStatus: threeWayMatchRequired 
          ? (threeWayMatchPassed ? 'PASSED' : 'FAILED')
          : 'NOT_REQUIRED',
        grCheckPassed: threeWayMatchPassed,
        step: 'PO_MATCHED',
        message: `Matched ${matchedCount} of ${doxItems.length} items. 3-way match: ${threeWayMatchPassed ? 'PASSED' : threeWayMatchRequired ? 'FAILED' : 'N/A'}`
      });

      await logProcess(tx, headerId, 'MATCH_PO', poMatchStatus, 
        matchedCount > 0 ? 'SUCCESS' : 'FAILURE',
        `Matched ${matchedCount}/${doxItems.length} items. 3-way: ${threeWayMatchPassed}`,
        { 
          matchedCount,
          totalItems: doxItems.length,
          threeWayMatchRequired,
          threeWayMatchPassed,
          topMatches: matches.slice(0, 5)
        }
      );

      LOG.info(`PO matching completed for invoice ${headerId}: ${matchedCount}/${doxItems.length} matched, 3-way: ${threeWayMatchPassed}`);

      return {
        totalDoxItems: doxItems.length,
        matchedItems: matchedCount,
        unmatchedItems: doxItems.length - matchedCount,
        threeWayMatchRequired,
        threeWayMatchPassed,
        confidence,
        status: poMatchStatus,
        message: `${matchedCount} of ${doxItems.length} items matched with ${confidence} confidence`,
        matches
      };

    } catch (error) {
      LOG.error('PO matching failed:', error);

      await tx.update(InvoiceHeader, headerId).set({
        poMatchStatus: 'ERROR',
        step: 'PO_MATCH_ERROR',
        lastError: error.message,
        lastErrorAt: new Date()
      });

      await logProcess(tx, headerId, 'MATCH_PO', 'ERROR', 'FAILURE',
        `PO matching error: ${error.message}`);

      req.error(500, `PO matching failed: ${error.message}`);
    }
  });

  // ============================================
  // SYNC PO FROM SAP
  // ============================================
  srv.on('SyncPOFromSAP', async (req) => {
    const { poNumber, headerId } = req.data;

    if (!poNumber || !headerId) {
      req.error(400, 'poNumber and headerId are required');
      return;
    }

    const tx = cds.tx(req);

    LOG.info(`Syncing PO ${poNumber} from SAP for invoice ${headerId}`);

    const DEST_NAME = process.env.S4_DEST_NAME || 'S4HANA';
    const SAP_CLIENT = process.env.S4_CLIENT || '100';
    const SYSTEM_KIND = process.env.S4_KIND || 'onprem';

    try {
      // Fetch PO items
      const poItems = await fetchPOItemsFromSAP(DEST_NAME, SAP_CLIENT, poNumber, SYSTEM_KIND);

      LOG.info(`Fetched ${poItems.length} PO items from SAP`);

      // Upsert PO items
      const itemsData = poItems.map(item => mapPOItem(item, SYSTEM_KIND, headerId));

      for (const item of itemsData) {
        const key = {
          PurchaseOrder: item.PurchaseOrder,
          PurchaseOrderItem: item.PurchaseOrderItem,
          invoiceHeader_ID: headerId
        };

        const existing = await tx.read(SAPPOItem).where(key);

        if (existing && existing.length > 0) {
          await tx.update(SAPPOItem).set(item).where({ ID: existing[0].ID });
        } else {
          await tx.run(INSERT.into(SAPPOItem).entries(item));
        }
      }

      // Refresh embeddings
      await srv.send({
        event: 'RefreshPOEmbeddings',
        data: { headerId }
      });

      // Fetch GR data
      const grData = await fetchGRDataFromSAP(DEST_NAME, SAP_CLIENT, poNumber, SYSTEM_KIND);

      LOG.info(`Fetched ${grData.length} GR records from SAP`);

      let grSynced = 0;
      if (grData.length > 0) {
        grSynced = await srv.send({
          event: 'UpsertGRSnapshots',
          data: { data: JSON.stringify({ headerId, items: grData }) }
        });
      }

      LOG.info(`PO sync completed: ${poItems.length} items, ${grSynced} GR records`);

      return {
        itemsSynced: poItems.length,
        grDataSynced: grSynced
      };

    } catch (error) {
      LOG.error(`Failed to sync PO ${poNumber}:`, error);
      req.error(500, `PO sync failed: ${error.message}`);
    }
  });

  // ============================================
  // UPSERT PO ITEMS (Internal)
  // ============================================
  srv.on('UpsertPOItems', async (req) => {
    const { data } = req.data;
    const payload = parseJSON(data);

    if (!payload) {
      req.error(400, 'Invalid JSON data');
      return;
    }

    const { headerId, items = [], systemKind = 'onprem' } = payload;

    if (!headerId || !items.length) {
      req.error(400, 'headerId and items are required');
      return;
    }

    const tx = cds.tx(req);
    let upserted = 0;

    for (const item of items) {
      const row = mapPOItem(item, systemKind, headerId);

      const key = {
        PurchaseOrder: row.PurchaseOrder,
        PurchaseOrderItem: row.PurchaseOrderItem,
        invoiceHeader_ID: headerId
      };

      const existing = await tx.read(SAPPOItem).where(key);

      if (existing && existing.length > 0) {
        await tx.update(SAPPOItem).set(row).where({ ID: existing[0].ID });
      } else {
        await tx.run(INSERT.into(SAPPOItem).entries(row));
      }

      upserted++;
    }

    LOG.info(`Upserted ${upserted} PO items`);

    return upserted;
  });

  // ============================================
  // UPSERT GR SNAPSHOTS (Internal)
  // ============================================
  srv.on('UpsertGRSnapshots', async (req) => {
    const { data } = req.data;
    const payload = parseJSON(data);

    if (!payload) {
      req.error(400, 'Invalid JSON data');
      return;
    }

    const { headerId, items = [] } = payload;

    if (!headerId || !items.length) {
      req.error(400, 'headerId and items are required');
      return;
    }

    const tx = cds.tx(req);
    let updated = 0;

    for (const grItem of items) {
      const key = {
        PurchaseOrder: grItem.PurchaseOrder,
        PurchaseOrderItem: grItem.PurchaseOrderItem,
        invoiceHeader_ID: headerId
      };

      const poItem = await tx.read(SAPPOItem).where(key);

      if (!poItem || poItem.length === 0) {
        LOG.warn(`PO item not found for GR: ${grItem.PurchaseOrder}-${grItem.PurchaseOrderItem}`);
        continue;
      }

      const current = poItem[0];
      const incQty = toNumber(grItem.QuantityInEntryUnit, 3) || 0;
      const newGrQty = (toNumber(current.GrQuantityPosted, 3) || 0) + incQty;
      const newOpenQty = (toNumber(current.OrderQuantity, 3) || 0) - newGrQty;

      await tx.update(SAPPOItem).set({
        GrQuantityPosted: newGrQty,
        OpenQuantity: newOpenQty,
        LastGRDocumentYear: grItem.MaterialDocumentYear,
        LastGRDocument: grItem.MaterialDocument,
        LastGRDocumentItem: grItem.MaterialDocumentItem,
        LastGRDate: grItem.PostingDate,
        LastGRMessage: grItem.Message
      }).where({ ID: current.ID });

      updated++;
    }

    LOG.info(`Updated ${updated} GR snapshots`);

    return updated;
  });

  // ============================================
  // REFRESH PO EMBEDDINGS (Internal)
  // ============================================
  srv.on('RefreshPOEmbeddings', async (req) => {
    const { headerId } = req.data;
    const db = cds.db;
    const physicalTable = 'JUNO_INVOICE_ASSISTANT_V1_SAPPOITEM';

    try {
      if (headerId) {
        await db.run(`
          UPDATE "${physicalTable}"
          SET "EMBEDDING" = VECTOR_EMBEDDING(
            COALESCE("MATERIAL",'') || ' ' || COALESCE("MATERIALNAME",''),
            'DOCUMENT',
            ?
          )
          WHERE "INVOICEHEADER_ID" = ?
        `, [MODEL, headerId]);
      } else {
        await db.run(`
          UPDATE "${physicalTable}"
          SET "EMBEDDING" = VECTOR_EMBEDDING(
            COALESCE("MATERIAL",'') || ' ' || COALESCE("MATERIALNAME",''),
            'DOCUMENT',
            ?
          )
        `, [MODEL]);
      }

      LOG.info('PO embeddings refreshed');
      return 1;
    } catch (error) {
      LOG.warn(`Embedding refresh failed: ${error.message}`);
      return 0;
    }
  });

  // ============================================
  // HELPERS
  // ============================================

  async function fetchPOItemsFromSAP(destName, client, poNumber, systemKind) {
    // Ensure PO number is padded to 10 digits for SAP
    const paddedPO = poNumber.padStart(10, '0');
    
    // Use relative path from destination base (which already has /sap/opu/odata/sap)
    const path = '/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrderItem';
    const filter = `PurchaseOrder eq '${paddedPO}'`;
    
    // Only select fields that exist in on-prem system
    const select = [
      'PurchaseOrder', 'PurchaseOrderItem', 'Material', 'PurchaseOrderItemText',
      'OrderQuantity', 'PurchaseOrderQuantityUnit', 'NetPriceAmount',
      'NetPriceQuantity', 'OrderPriceUnit', 'TaxCode', 'DocumentCurrency',
      'Plant', 'StorageLocation',
      'GoodsReceiptIsExpected', 'InvoiceIsExpected', 'InvoiceIsGoodsReceiptBased',
      'AccountAssignmentCategory', 'PurchaseOrderItemCategory'
    ].join(',');

    const url = buildUrl(path, {
      $filter: filter,
      $select: select,
      'sap-client': client,
      $format: 'json'
    });

    LOG.info(`Fetching PO items: PO ${paddedPO}, URL: ${url}`);

    const { data } = await executeHttpRequest(
      { destinationName: destName },
      { method: 'GET', url, headers: { Accept: 'application/json' } }
    );

    return data?.d?.results || data?.value || [];
  }

  async function fetchGRDataFromSAP(destName, client, poNumber, systemKind) {
    // On-premise systems typically don't have this API readily available
    // We'll skip GR fetch for now and rely on what's in the PO
    LOG.info('Skipping GR data fetch for on-premise system');
    return [];
  }

  function mapPOItem(raw, systemKind, headerId) {
    if (systemKind === 'onprem') {
      raw.Material = raw.Material || raw.MATNR;
      raw.MaterialName = raw.MaterialName || raw.TXZ01;
      raw.OrderQuantity = raw.OrderQuantity || raw.MENGE;
      raw.OrderUnit = raw.OrderUnit || raw.MEINS;
      raw.NetPriceAmount = raw.NetPriceAmount || raw.NETPR;
      raw.Currency = raw.Currency || raw.WAERS;
    }

    return {
      PurchaseOrder: raw.PurchaseOrder || raw.EBELN,
      PurchaseOrderItem: raw.PurchaseOrderItem || raw.EBELP,
      PurchaseOrderItemCategory: raw.PurchaseOrderItemCategory,
      Material: raw.Material,
      MaterialName: raw.MaterialName || raw.PurchaseOrderItemText,
      Plant: raw.Plant || raw.WERKS,
      StorageLocation: raw.StorageLocation || raw.LGORT,
      OrderQuantity: toNumber(raw.OrderQuantity, 3),
      OrderUnit: raw.OrderUnit || raw.PurchaseOrderQuantityUnit,
      OpenQuantity: toNumber(raw.OrderQuantity, 3),
      NetPriceAmount: toNumber(raw.NetPriceAmount, 2),
      NetPriceQuantity: toNumber(raw.NetPriceQuantity, 3),
      NetPriceQuantityUnit: raw.NetPriceQuantityUnit || raw.OrderPriceUnit,
      Currency: raw.Currency || raw.DocumentCurrency,
      TaxCode: raw.TaxCode,
      DeliveryDate: null, // Delivery date field not available in on-prem
      GoodsReceiptIsExpected: toBoolean(raw.GoodsReceiptIsExpected),
      InvoiceIsExpected: toBoolean(raw.InvoiceIsExpected),
      InvoiceIsGoodsReceiptBased: toBoolean(raw.InvoiceIsGoodsReceiptBased),
      AccountAssignmentCategory: raw.AccountAssignmentCategory,
      GLAccount: raw.GLAccount,
      CostCenter: raw.CostCenter,
      ServicePackage: raw.ServicePackage,
      ExpectedOverallLimitAmount: toNumber(raw.ExpectedOverallLimitAmount, 2),
      OverallLimitAmount: toNumber(raw.OverallLimitAmount, 2),
      GrQuantityPosted: 0,
      invoiceHeader_ID: headerId
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