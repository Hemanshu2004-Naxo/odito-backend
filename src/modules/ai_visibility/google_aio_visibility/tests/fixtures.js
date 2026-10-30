// Synthetic responses in the documented DataForSEO shape. NOT recordings of live calls: no live request has been made for this feature.
export const aioItem = (over = {}) => ({
  type: 'ai_overview', rank_group: 1, rank_absolute: 1, page: 1, position: 'left', asynchronous_ai_overview: true,
  items: [
    { type: 'ai_overview_element', title: 'Top eye hospitals', text: 'ASG Eye Hospital is a well known option in Nashik. Other options include Sankara Eye Care.', markdown: '**ASG Eye Hospital** is a [well known](https://example.org/x) option.', links: [{ type: 'link_element', title: 'Guide', url: 'https://www.asgeye.example/cataract?utm_source=x#top', domain: 'www.asgeye.example' }], references: [{ type: 'ai_overview_reference', source: 'Sankara Eye Care', domain: 'www.sankaraeye.example', url: 'https://www.sankaraeye.example/nashik', title: 'Sankara Nashik', text: 'snippet' }] },
    { type: 'ai_overview_expanded_element', title: 'More', text: 'Cataract surgery is common.', components: [{ title: 'c', text: 'Component text', markdown: 'Component text' }], references: [] },
  ],
  references: [
    { type: 'ai_overview_reference', source: 'Practo', domain: 'www.practo.example', url: 'https://www.practo.example/nashik/eye', title: 'Practo', text: 's' },
    { type: 'ai_overview_reference', source: 'Bad', domain: 'x', url: 'javascript:alert(1)', title: 'bad', text: '' },
  ],
  ...over,
});

export const organic = { type: 'organic', rank_group: 1, rank_absolute: 2, url: 'https://x.example', title: 't' };

export const serpResponse = (items, task = {}) => ({
  status_code: 20000, status_message: 'Ok.', cost: 0.0112,
  tasks: [{ id: '10281234-1234-0000-0000-abcdef012345', status_code: 20000, cost: 0.0112, result: [{ datetime: '2026-10-28 10:15:30 +00:00', check_url: 'https://www.google.com/search?q=x', items_count: items.length, items }], ...task }],
});
