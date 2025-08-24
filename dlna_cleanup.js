const dgram = require('dgram');
const request = require('request');

function parseHeaders(msg) {
  const lines = msg.split('\r\n');
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toUpperCase();
      const value = line.slice(idx + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

function discover(timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const message = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST:239.255.255.250:1900',
      'MAN:"ssdp:discover"',
      'MX:1',
      'ST:urn:schemas-upnp-org:device:MediaServer:1',
      '',
      ''
    ].join('\r\n'));
    const devices = [];
    socket.on('message', msg => {
      const headers = parseHeaders(msg.toString());
      const location = headers['LOCATION'];
      if (location && !devices.find(d => d.location === location)) {
        devices.push({ location });
      }
    });
    socket.on('error', reject);
    socket.send(message, 1900, '239.255.255.250');
    setTimeout(() => {
      socket.close();
      resolve(devices);
    }, timeout);
  });
}

function getContentDirectoryInfo(location) {
  return new Promise((resolve, reject) => {
    request.get(location, (err, res, body) => {
      if (err) return reject(err);
      const friendlyMatch = body.match(/<friendlyName>([^<]+)<\/friendlyName>/);
      const serviceRegex = /<service>([\s\S]*?)<\/service>/g;
      let service = null;
      let m;
      while ((m = serviceRegex.exec(body)) !== null) {
        if (m[1].includes('ContentDirectory')) {
          const typeMatch = m[1].match(/<serviceType>([^<]+)<\/serviceType>/);
          const controlMatch = m[1].match(/<controlURL>([^<]+)<\/controlURL>/);
          service = {
            serviceType: typeMatch && typeMatch[1],
            controlURL: controlMatch && controlMatch[1]
          };
          break;
        }
      }
      if (!service) return reject(new Error('ContentDirectory service not found'));
      const url = new URL(location);
      const controlURL = new URL(service.controlURL, url.origin).href;
      resolve({
        friendlyName: friendlyMatch ? friendlyMatch[1] : 'Unknown',
        serviceType: service.serviceType,
        controlURL
      });
    });
  });
}

function buildBrowseSoap(serviceType, objectId = '0') {
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n` +
    `  <s:Body>\n` +
    `    <u:Browse xmlns:u="${serviceType}">\n` +
    `      <ObjectID>${objectId}</ObjectID>\n` +
    `      <BrowseFlag>BrowseDirectChildren</BrowseFlag>\n` +
    `      <Filter>*</Filter>\n` +
    `      <StartingIndex>0</StartingIndex>\n` +
    `      <RequestedCount>200</RequestedCount>\n` +
    `      <SortCriteria></SortCriteria>\n` +
    `    </u:Browse>\n` +
    `  </s:Body>\n` +
    `</s:Envelope>`;
}

function buildDeleteSoap(serviceType, objectId) {
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n` +
    `  <s:Body>\n` +
    `    <u:DestroyObject xmlns:u="${serviceType}">\n` +
    `      <ObjectID>${objectId}</ObjectID>\n` +
    `    </u:DestroyObject>\n` +
    `  </s:Body>\n` +
    `</s:Envelope>`;
}

function unescapeXml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseDidl(didl) {
  const items = [];
  const regex = /<item[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = regex.exec(didl)) !== null) {
    const id = match[1];
    const block = match[2];
    const titleMatch = block.match(/<dc:title>([^<]*)<\/dc:title>/);
    const dateMatch = block.match(/<dc:date>([^<]*)<\/dc:date>/);
    items.push({
      id,
      title: titleMatch ? titleMatch[1] : '',
      date: dateMatch ? dateMatch[1] : ''
    });
  }
  return items;
}

function browse(device) {
  return new Promise((resolve, reject) => {
    const body = buildBrowseSoap(device.serviceType);
    request.post({
      url: device.controlURL,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${device.serviceType}#Browse"`
      },
      body
    }, (err, res, resBody) => {
      if (err) return reject(err);
      const resultMatch = resBody.match(/<Result>([\s\S]*?)<\/Result>/);
      if (!resultMatch) return resolve([]);
      const didl = unescapeXml(resultMatch[1]);
      resolve(parseDidl(didl));
    });
  });
}

function deleteObject(device, id) {
  return new Promise((resolve, reject) => {
    const body = buildDeleteSoap(device.serviceType, id);
    request.post({
      url: device.controlURL,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${device.serviceType}#DestroyObject"`
      },
      body
    }, err => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function main() {
  const devices = await discover();
  if (devices.length === 0) {
    console.log('No DLNA devices found');
    return;
  }
  for (const d of devices) {
    try {
      const info = await getContentDirectoryInfo(d.location);
      console.log(`Found: ${info.friendlyName}`);
      const items = await browse(info);
      items.forEach(i => console.log(`${i.id}: ${i.title} ${i.date}`));
      const maxAge = parseInt(process.env.MAX_AGE_DAYS || '30', 10);
      const now = Date.now();
      const toDelete = items.filter(i => i.date && (now - new Date(i.date).getTime()) > maxAge * 86400000);
      for (const item of toDelete) {
        console.log(`Deleting ${item.title}`);
        try {
          await deleteObject(info, item.id);
          console.log(`Deleted ${item.id}`);
        } catch (err) {
          console.error(`Failed to delete ${item.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error processing device:', err.message);
    }
  }
}

main().catch(err => console.error(err));
