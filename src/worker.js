/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */


import handleProxy from './proxy.js';
import handleRedirect from './redirect.js';
import apiRouter from './router.js';

import * as cheerio from 'cheerio';
import { Buffer } from 'buffer';

const URL_BASE = 'https://www.cernyrytir.cz:443/index.php3?akce=3';
const URL_IMAGE = 'https://www.cernyrytir.cz:443';
const CARDS_PER_PAGE = 30;

// For being good guy - do not overload the server those requests should be invalid though
const PAGE_SCRAPPING_LIMITATION = 20;

const CR_PARAM_TEMPLATE = {
  akce: 3,
  jmenokarty: 'XXX',
  rarita: 'A',
  limit: 0,
  foil: 'A',
  triditpodle: 'ceny',
  submit: 'Vyhledej'
};

function constructURLSets(baseUrl) {
  return new URL(baseUrl).toString();
}

function constructURL(baseUrl, params) {
  const url = new URL(baseUrl);
  const searchParams = new URLSearchParams(params);
  url.search = searchParams.toString();
  return url.toString();
}

function chunkArray(array, chunkSize) {
  if (chunkSize <= 0) {
    throw "Chunk size should be greater than zero.";
  }

  var result = [];
  for (var i = 0; i < array.length; i += chunkSize) {
    var chunk = array.slice(i, i + chunkSize);
    result.push(chunk);
  }
  return result;
}

function parsePageForSets(webpage) {
  const $ = cheerio.load(webpage);

  // Select the <select> element by its name attribute
  const selectElement = $('select[name="edice_magic"]');

  // Extract the options and their values
  return selectElement.children('option').map((index, element) => {
    const option = $(element);
    return {
      set: option.attr('value') || '',
      set_name: option.text()
    };
  }).get();
}

function parsePage(webpage) {
  const $ = cheerio.load(webpage);

  const cardsTable = $('table.kusovkytext');
  const cardFindTable = cardsTable.find('tbody').eq(1);

  let cardPrices = [];

  cardFindTable.each((i, row) => {

    const cardRows = $(row).children();

    chunkArray(cardRows, 3).forEach((chunk, i) => {
      console.log(`Chunk ${i}:`);

      const nameChild = chunk[0];
      const setTypeChild = chunk[1];
      const rarityAvailablePrice = chunk[2];

      let originalName = $(nameChild).find("font").text();
      let cardName = `${originalName}`;
      
      let cardFoil = false;
      if (cardName.includes("- foil")) {
        cardName = cardName.replace("- foil", "");
        cardFoil = true;
      }

      let cardCondition = "nm";
      if (cardName.includes("/ lightly played")) {
        cardName = cardName.replace("/ lightly played", "");
        cardCondition = "lp";
      }

      // TODO - here could be some nice regex which take the info from the () and then remove it from the card name
      // same comes with language mutations
      let cardAlternative = "";
      if (cardName.includes("(retro)")) {
        cardName = cardName.replace("(retro)", "");
        cardAlternative = 'retro';
      }
      if (cardName.includes("(borderless)")) {
        cardName = cardName.replace("(borderless)", "");
        cardAlternative = 'bordeless';
      }
      if (cardName.includes('(extended art)')) {
        cardName = cardName.replace("(extended art)", "");
        cardAlternative = 'extended art';
      }
      if (cardName.includes('(showcase)')) {
        cardName = cardName.replace("(showcase)", "");
        cardAlternative = 'showcase';
      }

      cardName = cardName.trim();

      const cardImageUrl = $(nameChild).find("a").attr('href');

      const cardSet = $(setTypeChild).find("td").eq(0).text().trim();
      const cardSetUrl = $(setTypeChild).find("td").eq(0).find("img").attr("src").trim();
      const cardType = $(setTypeChild).find("td").eq(1).text().trim();

      const cardRarity = $(rarityAvailablePrice).find("td").eq(0).text().trim();
      const cardQuantity = $(rarityAvailablePrice).find("td").eq(1).text().trim().match(/\d+/g).join('');
      const cardPrice = $(rarityAvailablePrice).find("td").eq(2).text().trim().match(/\d+/g).join('');

      // it's something like this /images/kusovkymagic/TMP/057.jpg
      // we need to extract TMP and 057
      const cardIdTokens = cardImageUrl.split("/");
      const cardId = cardIdTokens[3].toLocaleLowerCase() + '_' + cardIdTokens[4].split(".")[0];

      cardPrices.push({
        id: cardId,
        original_name: originalName,
        name: cardName,
        set: cardSet,
        set_url: URL_IMAGE + cardSetUrl,
        type: cardType,
        foil: cardFoil,
        rarity: cardRarity,
        quantity: Number(cardQuantity),
        price: Number(cardPrice),
        condition: cardCondition,
        alternative: cardAlternative,
        image_url: URL_IMAGE + cardImageUrl
      });
    });
  });

  return cardPrices;
}

function mapParameters(inParam, outParam, what, where) {
  if (inParam.hasOwnProperty(what)) {
    outParam[where] = inParam[what];
  }
}

function prepareCRParameters(reqParameters, parameters) {
  // copy the basics and then override what we can
  const par = { ...parameters };

  mapParameters(reqParameters, par, 'cardName', 'jmenokarty');
  mapParameters(reqParameters, par, 'rarity', 'rarita');
  // here could be maybe problem
  mapParameters(reqParameters, par, 'foil', 'foil');

  return par;
}

async function fetchWebpage(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/text',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  // Convert ArrayBuffer to Buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const decoder = new TextDecoder('windows-1250');

  return decoder.decode(buffer);
}

function fetchCardPages(webpage) {
  const $ = cheerio.load(webpage);

  const cardsTable = $('table.kusovkytext');
  const pageTable = cardsTable.prev();

  let pagesCount = 0;
  if (pageTable.text().includes('Nalezeno')) {
    // we know there is another page -> process it
    const pages = pageTable.text().split(':')[1].trim();
    const pagesNumbers = pages.split(/[\s\u00A0]+/);
    pagesCount = pagesNumbers.length + 1;
    console.log(`Pages: ${pagesNumbers}`);
  }

  return pagesCount;
}

async function handlePost(request, env, ctx) {
  try {
    // handle request body
    const inputBody = await request.json();
    const outputParameters = prepareCRParameters(inputBody, CR_PARAM_TEMPLATE);
    const url = constructURL(URL_BASE, outputParameters);

    const webpage = await fetchWebpage(url);
    let cardPrices = parsePage(webpage);

    // now figure out if there is another page
    const pagesCount = fetchCardPages(webpage);

    // start iterate over all pages and fetch data
    for (let page = 1; page <= pagesCount || page >= PAGE_SCRAPPING_LIMITATION; page++) {
      const url = constructURL(URL_BASE, { ...outputParameters, limit: page * CARDS_PER_PAGE });
      cardPrices = cardPrices.concat(parsePage(await fetchWebpage(url)));
    }

    return new Response(JSON.stringify(cardPrices), { "status": 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Error fetching data:', error);
    return new Response(`Internal server error: ${error}`, { "status": 500, headers: { "Content-Type": "text/plain" } });
  }
}

async function handleSets(request, env, ctx) {

  const url = constructURLSets(URL_BASE);

  const webpage = await fetchWebpage(url);
  const sets = parsePageForSets(webpage);

  return new Response(JSON.stringify(sets), { "status": 200, headers: { "Content-Type": "application/json" } });
}

// Export a default object containing event handlers
export default {
  // The fetch handler is invoked when this worker receives a HTTP(S) request
  // and should return a Response (optionally wrapped in a Promise)
  async fetch(request, env, ctx) {

    if (request.method == 'POST') {
      return handlePost(request, env, ctx);
    } else {

      const requestUrl = new URL(request.url);
      switch (requestUrl.pathname) {
        case '/sets':
          return handleSets(request, env, ctx);
        default:
          return new Response("Method not allowed", { "status": 405, headers: { "Content-Type": "text/plain" } });
      }
    }

    // You can get pretty far with simple logic like if/switch-statements


    //   case '/proxy':
    //     return handleProxy.fetch(request, env, ctx);
    // }


    // if (url.pathname.startsWith('/api/')) {
    //   // You can also use more robust routing
    //   return apiRouter.handle(request);
    // }

    // return new Response(
    // 	`Try making requests to:
    //   <ul>
    //   <li><code><a href="/redirect?redirectUrl=https://example.com/">/redirect?redirectUrl=https://example.com/</a></code>,</li>
    //   <li><code><a href="/proxy?modify&proxyUrl=https://example.com/">/proxy?modify&proxyUrl=https://example.com/</a></code>, or</li>
    //   <li><code><a href="/api/todos">/api/todos</a></code></li>`,
    // 	{ headers: { "Content-Type": "text/html" } }
    // );
  },
};