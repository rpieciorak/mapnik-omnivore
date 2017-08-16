var fs = require('fs');
var invalid = require('./invalid');
var SphericalMercator = require('@mapbox/sphericalmercator');
var sm = new SphericalMercator();

var SMALLEST_MAX_ZOOM_FILE_SIZE = 1000000; // 1mb
var DEFAULT_SMALLEST_MAX_ZOOM = 6;

module.exports.zoomsBySize = function(filepath, extent, datasource, callback) {

  // currently the ogr plugin doesn't pass in a datasource,
  // so we need to redefine the callback
  if (typeof datasource === 'function') callback = datasource;

  var maxSize = 500 * 1024;
  var max = 22;
  var min;

  fs.stat(filepath, function(err, stats) {
    if (err) return callback(err);

    var x;
    var y;
    var z;
    var bounds;
    var tiles;
    var avg;

    var smallestMinZoom = getDynamicMinZoom(getSpatialResolutions(), extent, 512, 0.1, Number.MAX_SAFE_INTEGER)
    // set a "smallest max zoom" for different data types
    var smallestMaxZoom = stats.size < SMALLEST_MAX_ZOOM_FILE_SIZE ? dataTypeMaxZoom(datasource) : DEFAULT_SMALLEST_MAX_ZOOM;

    for (z = max; z >= 0; z--) {
      bounds = sm.xyz(extent, z, false, 4326);
      x = (bounds.maxX - bounds.minX) + 1;
      y = (bounds.maxY - bounds.minY) + 1;
      tiles = x * y;

      if (tiles <= 0) {
        return callback(invalid('Error calculating min/max zoom: Bounds invalid'));
      }

      if (stats.size <= 0) {
        return callback(invalid('Error calculating min/max zoom: Total bytes less than or equal to zero'));
      }

      avg = stats.size / tiles;

      if (avg < 1000) max = z;
      if (avg > maxSize) {
        max = Math.max(max, smallestMaxZoom);
        min = Math.min(smallestMinZoom, z);
        min = Math.min(min, max);
        return callback(null, min, max);
      } else if (tiles === 1 || z === 0) {
        max = Math.max(max, smallestMaxZoom);
        min = Math.min(max, smallestMinZoom);
        return callback(null, min, max);
      }
    }
  });
};

/**
 * Calculates the smallest max zoom a datasource should be tiled to. This is used for small datasources
 * where precision can be lost due to large tile extents. https://github.com/mapbox/mapnik-omnivore/issues/151
 *
 * @param {object} datasource A Node Mapnik datasource object
 * @returns {number} zoom The smallest max zoom to use for the datasource
 */
module.exports.dataTypeMaxZoom = dataTypeMaxZoom;
var dataTypeMaxZoom = function(ds) {

  // try describing the datasource (this catches the ogr hole)
  var info;
  try {
    info = ds.describe();
  } catch (err) {
    return DEFAULT_SMALLEST_MAX_ZOOM;
  }

  // for point features, tile down to z10
  if (info.geometry_type === 'point') {
    return 10;
  }

  // return 6 for all other data types for now
  return DEFAULT_SMALLEST_MAX_ZOOM;
};

module.exports.convertToMeters = function(pixelSize, unit) {
  var circumference = 40075000;
  var conversions = {
    m: function(x) { return x; },

    ft: function(x) { return x * 0.3048; },

    mi: function(x) { return x * 1609.34; },

    km: function(x) { return x * 1000; },

    'us-ft': function(x) { return x * 0.3048; },

    'us-mi': function(x) { return x * 1609.34; },

    'decimal degrees': function(x) { return x / 360 * circumference; }
  };

  if (!conversions[unit]) throw new Error('Invalid unit type, must be one of: [m, ft, mi, km, us-ft, us-mi]');

  var x = conversions[unit](pixelSize[0]);
  var y = conversions[unit](pixelSize[1]);

  return [x, y];
};

module.exports.getUnitType = function(srs) {
  var possibleUnits = ['m', 'ft', 'mi', 'km', 'us-ft', 'us-mi'];
  var i;

  for (i = 0; i < possibleUnits.length; i++) {
    if (srs.indexOf('+units=' + possibleUnits[i]) !== -1) return possibleUnits[i];
  }

  if (srs.indexOf('+units=') === -1 && srs.indexOf('+proj=longlat') !== -1) return 'decimal degrees';

  //Default to meters for now, if nothing matches
  else return 'm';
};

module.exports.getSpatialResolutions = getSpatialResolutions
function getSpatialResolutions() {
  var circumference = 40075000;
  var zoomLevels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];

  return zoomLevels.map(function(z) {
    return circumference * Math.cos(0) / Math.pow(2, (z + 8));
  });
};

module.exports.getValidSpatialResolutions = function(spatialResolutions, pixelSize, thresholdWeight) {
  return spatialResolutions.filter(function(res, i) {
    var zBreak = res - spatialResolutions[Math.min(i + 1, spatialResolutions.length - 1)] * thresholdWeight;
    return zBreak > pixelSize;
  });
};

/**
 * Calculates dynamically minZoom for raster sources.
 * Minzoom would be calculated dynamically only for small areas (no more then *sizeLimit*).
 *
 * @param {array} spatialResolutions spatial resolution for every zoom level
 * @param {array} extent raster extent in WGS84
 * @param {number} tileSize size of the tile [px]
 * @returns {number} zoom The smallest min zoom to use for the datasource
 */
function getDynamicMinZoom(spatialResolutions, extent, tileSize, ratio = 0.05, sizeLimit = 50 * 100) {
  // var sizeLimit = 50 * 1000; // 50 km max
  // var ratio = 0.05; // smallest tile area that have to be covered by raster - 5%
  var ex = sm.convert(extent, '900913');
  var w = ex[2] - ex[0];
  var h = ex[3] - ex[1];
  var maxSize = Math.max(w, h);
  var minSize = Math.min(w, h);

  if (minSize >= sizeLimit) {
    return null;
  }

  var zooms = spatialResolutions.filter(function(res, z) {
    var pxPerMeter = spatialResolutions[z];   // pixels per meter
    var size = maxSize / pxPerMeter;          // pixels occupied by raster width or height [m] in current zoom level
    return size >= tileSize * ratio;
  });

  var minZoom = spatialResolutions.length - zooms.length;

  return minZoom;
};

module.exports.getDynamicMinZoom = getDynamicMinZoom