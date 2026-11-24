import {
  pressingsDue,
  pressingsOrder,
  refreshPressings,
  type PressingsFile,
} from './pressings-refresh';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-24T00:00:00.000Z');

const versions = [
  { id: 2, format: 'LP, Album, Reissue', released: '2019', country: 'US' },
  { id: 1, format: 'LP, Album', released: '1991', country: 'UK' },
  { id: 3, format: 'LP, Album, Unofficial Release', released: '2001' },
];
const detail = (text: string) => ({
  formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP', 'Album'], text }],
});

function fakeDiscogs() {
  return jest.fn(async (pathname: string) => {
    if (pathname === '/masters/42/versions') return { pagination: { pages: 1 }, versions };
    const id = Number(pathname.match(/\/releases\/(\d+)/)?.[1]);
    return detail(id === 1 ? 'Black' : 'Red');
  });
}

const complete = (cachedAt: number): PressingsFile => ({
  cachedAt: new Date(cachedAt).toISOString(),
  next: null,
  versions: [],
  pressings: [],
});

describe('pressingsDue', () => {
  it('rechecks older albums every 90 days and recent ones every 14', () => {
    expect(pressingsDue({ masterId: 1, year: 1990 }, undefined, now)).toBe(true);
    expect(pressingsDue({ masterId: 1, year: 1990 }, complete(now - 30 * DAY_MS), now)).toBe(false);
    expect(pressingsDue({ masterId: 1, year: 1990 }, complete(now - 91 * DAY_MS), now)).toBe(true);
    expect(pressingsDue({ masterId: 1, year: 2026 }, complete(now - 15 * DAY_MS), now)).toBe(true);
    expect(pressingsDue({ masterId: 1 }, { ...complete(now), next: 3 }, now)).toBe(true);
  });
});

describe('pressingsOrder', () => {
  it('finishes albums partway through first, then new ones, then the oldest', () => {
    const files = new Map<number, PressingsFile>([
      [1, complete(now - 200 * DAY_MS)],
      [2, { ...complete(now - DAY_MS), next: 4 }],
      [4, complete(now - DAY_MS)],
    ]);
    const order = pressingsOrder(
      [{ masterId: 1 }, { masterId: 2 }, { masterId: 3 }, { masterId: 4 }],
      files,
      now,
    );
    expect(order.map((album) => album.masterId)).toEqual([2, 3, 1]);
  });
});

describe('refreshPressings', () => {
  it('saves every official pressing with its details, sorted by year', async () => {
    const get = fakeDiscogs();
    const save = jest.fn(async () => undefined);

    const file = await refreshPressings(42, undefined, get as never, () => true, save);

    expect(file.next).toBeNull();
    expect(file.versions).toEqual([]);
    expect(file.pressings.map((pressing) => [pressing.releaseId, pressing.details])).toEqual([
      [1, 'Black'],
      [2, 'Red'],
    ]);
    expect(save).toHaveBeenLastCalledWith(file);
  });

  it('stops when time runs out and continues where it left off', async () => {
    const get = fakeDiscogs();
    let budget = 1;
    const saved: PressingsFile[] = [];
    const save = jest.fn(async (file: PressingsFile) => {
      saved.push(JSON.parse(JSON.stringify(file)));
    });

    const partial = await refreshPressings(42, undefined, get as never, () => budget-- > 0, save);
    expect(partial.next).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);

    get.mockClear();
    const done = await refreshPressings(42, saved.at(-1), get as never, () => true, save);
    expect(done.next).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/releases/1');
    expect(done.pressings.every((pressing) => pressing.detailed)).toBe(true);
  });

  it('only looks up new pressings when rechecking', async () => {
    const get = fakeDiscogs();
    const first = await refreshPressings(42, undefined, get as never, () => true, jest.fn());
    get.mockClear();

    await refreshPressings(42, first, get as never, () => true, jest.fn());

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/masters/42/versions', expect.anything());
  });
});
