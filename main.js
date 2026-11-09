


// constants & shared state ----------
const YMIN = 2000, YMAX = 2020;
const MIN_N_FOR_RATE = 5;
const svg = d3.select('#map');
const W = +svg.attr('width'), H = +svg.attr('height');
const LEGEND_H = 50;
const tip = d3.select('#tooltip');

const state = { year: YMIN, eth: 'All', fado: 'All', metric: 'count', selected: null };

Promise.all([d3.json('precincts.geojson'), d3.json('complaints.json')]).then(([geo, data]) => {

  // ---------- 1. parse rows: one object per unique complaint ----------
  const complaints = data.rows.map(r => ({
    year: r[0], precinct: r[1], eth: r[2], gender: r[3], age: r[4], fado: r[5], sub: r[6] === 1
  }));

  // ---------- 2. fill the dropdowns ----------
  const eths = ['All', ...[...new Set(complaints.flatMap(d => d.eth))].sort()];
  const fados = ['All', ...[...new Set(complaints.flatMap(d => d.fado))].sort()];
  d3.select('#eth').selectAll('option').data(eths).join('option').attr('value', d => d).text(d => d);
  d3.select('#fado').selectAll('option').data(fados).join('option').attr('value', d => d).text(d => d);

  // ---------- 3. draw the map once (data join: one path per precinct) ----------
  const projection = d3.geoMercator().fitSize([W, H - LEGEND_H], geo);
  const path = d3.geoPath(projection);
  const paths = svg.append('g').attr('transform', `translate(0,${LEGEND_H})`)
    .selectAll('path').data(geo.features).join('path')
    .attr('class', 'precinct').attr('d', path);
  const legend = svg.append('g').attr('class', 'legend').attr('transform', 'translate(20,8)');

  // ---------- 4. filtering & aggregation helpers ----------

  function matches(d, eth, fado) {
    return (eth === 'All' || d.eth.includes(eth)) && (fado === 'All' || d.fado.includes(fado));
  }


  function aggregateByPrecinct(rows) {
    return d3.rollup(rows, v => ({ n: v.length, sub: d3.sum(v, d => d.sub) }), d => d.precinct);
  }


  function metricValue(s) {
    if (!s) return state.metric === 'count' ? 0 : null;
    if (state.metric === 'count') return s.n;
    return s.n >= MIN_N_FOR_RATE ? s.sub / s.n : null;
  }

  // ---------- 5. color scale with a FIXED domain over all years ----------
  function computeColorScale(filtered) {
    let max = 0;

    d3.rollup(filtered, v => v, d => d.year).forEach(rowsOfYear => {
      aggregateByPrecinct(rowsOfYear).forEach(s => {
        const v = metricValue(s);
        if (v != null && v > max) max = v;
      });
    });
    const interp = state.metric === 'count' ? d3.interpolateYlOrRd : d3.interpolatePurples;
    return d3.scaleSequential(interp).domain([0, max || 1]);
  }

  let color, lookup = new Map(), filtered = [];

  // ---------- 6. main update: runs on every control change ----------
  function update() {
    d3.select('#yearLabel').text(state.year);
    filtered = complaints.filter(d => matches(d, state.eth, state.fado));
    color = computeColorScale(filtered);
    lookup = aggregateByPrecinct(filtered.filter(d => d.year === state.year));

    paths.classed('selected', d => d.properties.precinct === state.selected)
      .transition().duration(300)
      .attr('fill', d => {
        const v = metricValue(lookup.get(d.properties.precinct));
        return v == null || v === 0 && state.metric === 'count' ? '#eee' : color(v);
      });

    paths.filter('.selected').raise();

    const n = d3.sum([...lookup.values()], s => s.n), sub = d3.sum([...lookup.values()], s => s.sub);
    d3.select('#total').text(`${state.year}: ${n} complaints, ${n ? Math.round(100 * sub / n) : 0}% substantiated (current filters)`);
    drawLegend();
    drawPanel();
  }

  // ---------- 7. legend (gradient + axis) ----------
  function drawLegend() {
    legend.selectAll('*').remove();
    const w = 260, max = color.domain()[1];
    const grad = legend.append('defs').append('linearGradient').attr('id', 'grad');
    d3.range(0, 1.01, 0.1).forEach(t => grad.append('stop').attr('offset', t).attr('stop-color', color(t * max)));
    legend.append('rect').attr('width', w).attr('height', 12).attr('fill', 'url(#grad)');
    legend.append('g').attr('transform', 'translate(0,12)')
      .call(d3.axisBottom(d3.scaleLinear([0, max], [0, w])).ticks(5, state.metric === 'count' ? 'd' : '.0%'));
    legend.append('text').attr('x', w + 10).attr('y', 11)
      .text(state.metric === 'count' ? 'unique complaints / year (grey = 0)'
                                    : `substantiated % (grey = fewer than ${MIN_N_FOR_RATE} complaints)`);
  }

  // ---------- 8. tooltip ----------
  paths.on('mousemove', (ev, d) => {
    const p = d.properties.precinct, s = lookup.get(p);
    const rate = s && s.n ? d3.format('.0%')(s.sub / s.n) : 'n/a';
    tip.classed('hidden', false).style('left', ev.pageX + 12 + 'px').style('top', ev.pageY + 12 + 'px')
      .html(`<b>Precinct ${p}</b> (${state.year})<br>${s ? s.n : 0} complaints<br>${rate} substantiated<br><i>click for details</i>`);
  }).on('mouseleave', () => tip.classed('hidden', true));

  // ---------- 9. click = select precinct (linked side panel) ----------
  paths.on('click', (ev, d) => {
    const p = d.properties.precinct;
    state.selected = state.selected === p ? null : p;
    update();
  });
  d3.select(window).on('keydown', ev => { if (ev.key === 'Escape') { state.selected = null; update(); } });

  // ---------- 10. side panel with small bar charts ----------

  function categoryShares(rows, field, cats) {
    return cats.map(c => ({ cat: c, share: rows.length ? rows.filter(d => d[field].includes(c)).length / rows.length : 0 }));
  }

  function drawPanel() {
    const charts = d3.select('#charts');
    charts.selectAll('*').remove();
    if (state.selected == null) {
      d3.select('#panelTitle').text('Click a precinct');
      d3.select('#panelHint').style('display', null);
      return;
    }
    d3.select('#panelHint').style('display', 'none');

    const yearRows = complaints.filter(d => d.year === state.year && matches(d, 'All', state.fado));
    const pRows = yearRows.filter(d => d.precinct === state.selected);
    d3.select('#panelTitle').text(`Precinct ${state.selected}, ${state.year}: ${pRows.length} complaints`);
    charts.append('p').style('color', '#666')
      .text(`Bars = this precinct, black outline = all of NYC. Allegation filter: ${state.fado}. ` +
            'A complaint can have several complainants, so shares can add up to more than 100%.');
    if (!pRows.length) { charts.append('p').text('No complaints for this precinct with these filters.'); return; }

    const fields = [
      ['eth', 'Complainant ethnicity', eths.slice(1)],
      ['gender', 'Complainant gender', ['Male', 'Female', 'Other', 'Unknown']],
      ['age', 'Complainant age', ['<18', '18-24', '25-34', '35-44', '45-54', '55+', 'Unknown']],
    ];
    fields.forEach(([field, title, cats]) => {
      const local = categoryShares(pRows, field, cats);
      const city = categoryShares(yearRows, field, cats);
      barChart(charts, title, local, city);
    });

    const share = rows => rows.length ? d3.mean(rows, d => d.sub ? 1 : 0) : 0;
    barChart(charts, 'Outcome (at least one allegation substantiated)',
      [{ cat: 'Substantiated', share: share(pRows) }, { cat: 'Not substantiated', share: 1 - share(pRows) }],
      [{ cat: 'Substantiated', share: share(yearRows) }, { cat: 'Not substantiated', share: 1 - share(yearRows) }]);
  }


  function barChart(container, title, local, city) {
    const m = { l: 110, r: 40, t: 2, b: 4 }, w = 360, rowH = 16, h = local.length * rowH + m.t + m.b;
    container.append('div').attr('class', 'chart-title').text(title);
    const g = container.append('svg').attr('class', 'chart').attr('width', w).attr('height', h)
      .append('g').attr('transform', `translate(${m.l},${m.t})`);
    const x = d3.scaleLinear([0, d3.max([...local, ...city], d => d.share) || 1], [0, w - m.l - m.r]);
    const y = d3.scaleBand(local.map(d => d.cat), [0, h - m.t - m.b]).padding(0.2);
    g.selectAll('.bar').data(local).join('rect').attr('class', 'bar')
      .attr('y', d => y(d.cat)).attr('height', y.bandwidth()).attr('width', d => x(d.share));
    g.selectAll('.bar-city').data(city).join('rect').attr('class', 'bar-city')
      .attr('y', d => y(d.cat)).attr('height', y.bandwidth()).attr('width', d => x(d.share));
    g.selectAll('.label').data(local).join('text').attr('x', -6).attr('y', d => y(d.cat) + y.bandwidth() / 2)
      .attr('dy', '0.35em').attr('text-anchor', 'end').text(d => d.cat);
    g.selectAll('.value').data(local).join('text').attr('x', d => Math.max(x(d.share), x(city.find(c => c.cat === d.cat).share)) + 4)
      .attr('y', d => y(d.cat) + y.bandwidth() / 2).attr('dy', '0.35em').text(d => d3.format('.0%')(d.share));
  }

  // ---------- 11. wire up the controls ----------
  d3.select('#year').on('input', function () { state.year = +this.value; update(); });
  d3.select('#eth').on('change', function () { state.eth = this.value; update(); });
  d3.select('#fado').on('change', function () { state.fado = this.value; update(); });
  d3.selectAll('input[name=metric]').on('change', function () { state.metric = this.value; update(); });

  update();
});
