import { HiddenAlbumsService } from './hidden-albums.service';

describe('HiddenAlbumsService', () => {
  afterEach(() => localStorage.clear());

  it('remembers hidden albums on this device', () => {
    new HiddenAlbumsService().hide(42);

    const reloaded = new HiddenAlbumsService();
    expect(reloaded.isHidden(42)).toBe(true);
    expect(reloaded.isHidden(7)).toBe(false);
  });

  it('unhides an album', () => {
    const service = new HiddenAlbumsService();
    service.hide(42);
    service.unhide(42);

    expect(service.isHidden(42)).toBe(false);
    expect(new HiddenAlbumsService().isHidden(42)).toBe(false);
  });

  it('ignores unreadable saved data', () => {
    localStorage.setItem('hidden-missing-albums', 'not json');
    expect(new HiddenAlbumsService().hidden().size).toBe(0);
  });
});
