import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export class TasksAdapter {
  private breaker = new CircuitBreaker('GoogleTasks');
  private tasks;

  constructor(auth?: any) {
    const authClient = auth ?? (() => {
      const a = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      a.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return a;
    })();
    this.tasks = google.tasks({ version: 'v1', auth: authClient });
  }

  async getTaskLists(): Promise<TaskList[]> {
    const cacheKey = 'tasks:lists';
    const cached = cache.get<TaskList[]>(cacheKey);
    if (cached) return cached;

    const result = await this.breaker.call(() =>
      withRetry(() => this.tasks.tasklists.list({ maxResults: 10 }))
    );

    const lists = (result.data.items ?? []).map(l => ({
      id: l.id!,
      title: l.title!,
    }));

    cache.set(cacheKey, lists, 5 * 60 * 1000);
    return lists;
  }

  async getTasks(taskListId = '@default', maxResults = 20): Promise<Task[]> {
    const cacheKey = `tasks:list:${taskListId}`;
    const cached = cache.get<Task[]>(cacheKey);
    if (cached) return cached;

    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.tasks.tasks.list({
          tasklist: taskListId,
          maxResults,
          showCompleted: false,
        })
      )
    );

    const tasks = (result.data.items ?? []).map(t => ({
      id: t.id!,
      title: t.title!,
      notes: t.notes ?? undefined,
      due: t.due ?? undefined,
      status: t.status as 'needsAction' | 'completed',
      completed: t.completed ?? undefined,
    }));

    cache.set(cacheKey, tasks, 2 * 60 * 1000);
    return tasks;
  }

  async createTask(
    title: string,
    notes?: string,
    dueDate?: string,
    taskListId = '@default',
  ): Promise<Task> {
    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.tasks.tasks.insert({
          tasklist: taskListId,
          requestBody: {
            title,
            notes,
            due: dueDate ? `${dueDate}T00:00:00.000Z` : undefined,
          },
        })
      )
    );

    cache.invalidatePattern('tasks:');
    logger.info('Tarea creada', { data: { title, due: dueDate } });

    return {
      id: result.data.id!,
      title: result.data.title!,
      notes: result.data.notes ?? undefined,
      due: result.data.due ?? undefined,
      status: result.data.status as 'needsAction' | 'completed',
    };
  }

  async completeTask(taskId: string, taskListId = '@default'): Promise<void> {
    await this.breaker.call(() =>
      withRetry(() =>
        this.tasks.tasks.patch({
          tasklist: taskListId,
          task: taskId,
          requestBody: { status: 'completed' },
        })
      )
    );

    cache.invalidatePattern('tasks:');
    logger.info('Tarea completada', { data: { taskId } });
  }

  async createCobroTask(
    clienteNombre: string,
    monto: number,
    fechaVencimiento: string,
    asignadoA?: string,
  ): Promise<Task> {
    return this.createTask(
      `💰 Cobrar a ${clienteNombre} — Bs. ${monto.toLocaleString('es-BO')}`,
      `Cliente: ${clienteNombre}\nMonto: Bs. ${monto.toLocaleString('es-BO')}\nVencimiento: ${fechaVencimiento}${asignadoA ? `\nAsignado a: ${asignadoA}` : ''}`,
      fechaVencimiento,
    );
  }

  async createLeadTask(
    leadNombre: string,
    productoInteres: string,
    fechaSeguimiento: string,
    asignadoA?: string,
  ): Promise<Task> {
    return this.createTask(
      `📞 Seguimiento: ${leadNombre} — ${productoInteres}`,
      `Lead: ${leadNombre}\nProducto: ${productoInteres}${asignadoA ? `\nAsignado a: ${asignadoA}` : ''}`,
      fechaSeguimiento,
    );
  }
}