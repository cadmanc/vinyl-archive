import { Component, input, output } from '@angular/core';
import { Router } from '@angular/router';

export type NavigationSection = 'player' | 'collection';

@Component({
  selector: 'app-navigation-controls',
  standalone: true,
  templateUrl: './navigation-controls.component.html',
  styleUrls: ['./navigation-controls.component.scss'],
})
export class NavigationControlsComponent {
  activeSection = input<NavigationSection>('player');
  showHistory = input(true);
  showStats = input(true);
  showAchievements = input(true);
  showCollection = input(true);

  search = output<void>();
  history = output<void>();
  stats = output<void>();
  achievements = output<void>();
  menu = output<void>();

  constructor(private router: Router) {}

  openCollection(): void {
    this.router.navigate(['/collection']);
  }
}
