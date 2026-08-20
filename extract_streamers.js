#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const inputFile = process.argv[2] || path.join(__dirname, 'index_29_3.html');
const outputFile = path.join(__dirname, 'streamers.json');

if (!fs.existsSync(inputFile)) {
  console.error(`✗ Input file not found: ${inputFile}`);
  process.exit(1);
}

console.log(`📖 Reading: ${inputFile}`);
const htmlContent = fs.readFileSync(inputFile, 'utf-8');

// DOMパース
const dom = new JSDOM(htmlContent);
const document = dom.window.document;

const streamers = [];
let id = 1;

// .streamer-cardを全て取得
const cards = document.querySelectorAll('.streamer-card');
console.log(`Found ${cards.length} streamer cards`);

cards.forEach((card, idx) => {
  try {
    // 名前
    const nameEl = card.querySelector('.streamer-name');
    const name = nameEl ? nameEl.textContent.trim() : '';

    // 読み仮名
    const yomiEl = card.querySelector('.streamer-yomi');
    const yomi = yomiEl ? yomiEl.textContent.trim() : '';

    // 写真
    const photoEl = card.querySelector('.streamer-photo');
    const photoUrl = photoEl && photoEl.src ? photoEl.src : '';

    // SNS
    const sns = [];
    const snsLinks = card.querySelectorAll('.streamer-sns a');
    snsLinks.forEach(link => {
      const platform = link.textContent.match(/([^\d@]+)/)?.[1]?.trim() || '';
      const snsId = link.querySelector('.snsid')?.textContent || link.textContent.replace(platform, '').trim();
      if (platform && snsId) {
        sns.push({
          platform: platform,
          id: snsId,
          url: link.href || ''
        });
      }
    });

    // 配信サイト
    const sites = [];
    const siteRows = card.querySelectorAll('.site-row');
    siteRows.forEach(row => {
      const nameSpan = row.querySelector('.site-name');
      const idSpan = row.querySelector('.site-id');
      if (nameSpan && idSpan) {
        sites.push({
          name: nameSpan.textContent.trim(),
          id: idSpan.textContent.replace('@', '').trim()
        });
      }
    });

    // 紹介文（最初の段落 or フリーテキスト）
    const introEl = card.querySelector('.streamer-info');
    let intro = '';
    if (introEl) {
      // .streamer-snsと.streamer-gridと.streamer-topicsの後のテキスト
      const children = Array.from(introEl.children);
      const gridIdx = children.findIndex(el => el.classList.contains('streamer-grid'));
      if (gridIdx !== -1 && gridIdx + 1 < children.length) {
        const nextEl = children[gridIdx + 1];
        if (nextEl && !nextEl.classList.contains('streamer-topics')) {
          intro = nextEl.textContent.trim();
        }
      }
    }

    if (!name) {
      console.warn(`⚠ Skipped card ${idx}: no name found`);
      return;
    }

    const streamer = {
      id: `streamer_${id}`,
      name: name,
      yomi: yomi,
      photoUrl: photoUrl,
      sns: sns,
      sites: sites,
      intro: intro
    };

    streamers.push(streamer);
    id++;
    console.log(`✓ ${name} (${yomi})`);

  } catch (err) {
    console.error(`✗ Error parsing card ${idx}:`, err.message);
  }
});

// JSONに保存
fs.writeFileSync(outputFile, JSON.stringify(streamers, null, 2), 'utf-8');
console.log(`\n✓ Saved ${streamers.length} streamers to ${outputFile}`);
